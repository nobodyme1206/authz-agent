import asyncio, hmac, json, os, shutil, uuid
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, func, text
from .db import Base, engine, Session, Project, Snapshot, Job, Event, Worker, Stage1State, Stage1Api, now, secret
from .files import safe_path, snapshot_tree, read_evidence
from .migrations import upgrade
from . import stage1

SOURCES = Path(os.getenv('SOURCE_ROOT', '/sources'))
SNAPSHOTS = Path(os.getenv('SNAPSHOT_ROOT', '/snapshots'))
RUNS = Path(os.getenv('RUN_ROOT', '/runs'))
TERMINAL = {'completed', 'failed', 'cancelled'}

def uid(prefix): return prefix + '-' + uuid.uuid4().hex

def get_db():
    with Session() as db: yield db

def internal(x_worker_token: str = Header(default='')):
    token = secret('INTERNAL_TOKEN_FILE')
    if not token or not hmac.compare_digest(token, x_worker_token): raise HTTPException(401, 'unauthorized_worker')

def get(db, cls, identifier):
    obj = db.get(cls, identifier)
    if not obj: raise HTTPException(404, 'not_found')
    return obj

def job_lock(db, identifier):
    obj = db.scalar(select(Job).where(Job.id == identifier).with_for_update())
    if not obj: raise HTTPException(404, 'job_not_found')
    return obj

def event(db, job, kind, data=None):
    seq = (db.scalar(select(func.max(Event.seq)).where(Event.job_id == job.id)) or 0) + 1
    db.add(Event(job_id=job.id, seq=seq, type=kind, data=data or {}))
    db.flush()

def public(obj):
    excluded = {'worker'}
    if isinstance(obj, Job) and obj.kind == 'stage1_extract': excluded.add('result')
    result = {c.name: getattr(obj, c.name) for c in obj.__table__.columns if c.name not in excluded}
    if isinstance(obj, Job) and obj.kind == 'stage1_extract':
        result['result'] = None  # Large stage results use the dedicated result endpoint.
    return result

def stale(db):
    cutoff = now() - timedelta(seconds=90)
    jobs = db.scalars(select(Job).where(Job.state.in_(['running','cancel_requested']), Job.heartbeat < cutoff).with_for_update()).all()
    for j in jobs:
        j.state = 'cancelled' if j.state == 'cancel_requested' else 'failed'
        j.error = 'worker_interrupted'
        if j.kind == 'stage1_extract': j.result = stage1.envelope(db, j, True)
        event(db, j, 'interrupted', {'code': 'worker_interrupted'})

@asynccontextmanager
async def lifespan(app):
    if not secret('INTERNAL_TOKEN_FILE'): raise RuntimeError('internal token required')
    SNAPSHOTS.mkdir(parents=True, exist_ok=True); RUNS.mkdir(parents=True, exist_ok=True)
    upgrade(engine)
    yield

app = FastAPI(title='Authz Agent · Stage 1', lifespan=lifespan)

@app.exception_handler(Exception)
async def safe_error(request, exc):
    return JSONResponse(status_code=500, content={'detail': 'internal_error'})

class ProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    source: str = Field(min_length=1, max_length=200)
class ProbeInput(BaseModel):
    snapshot_id: str
    file: str | None = Field(default=None, min_length=1, max_length=500)
    kind: Literal['agent_probe', 'stage1_extract'] = 'agent_probe'
    options: dict = Field(default_factory=dict)
class BootInput(BaseModel):
    key: str = 'primary'
    boot: str
    model: dict = Field(default_factory=dict)
class WorkerInput(BaseModel):
    key: str = 'primary'
    boot: str
class JobUpdate(WorkerInput):
    type: str = Field(max_length=80)
    data: dict = Field(default_factory=dict)
class Finish(WorkerInput):
    state: Literal['completed','failed','cancelled']
    result: dict | None = None
    error: str | None = Field(default=None, max_length=200)
class Checkpoint(WorkerInput):
    entries: list[dict] = Field(default_factory=list)
    scan: dict | None = None

@app.get('/api/health')
def health(db=Depends(get_db)):
    db.execute(text('SELECT 1'))
    stale(db); db.commit()
    w = db.get(Worker, 'primary')
    online = bool(w and (now() - (w.seen.replace(tzinfo=now().tzinfo) if w.seen.tzinfo is None else w.seen)).total_seconds() < 45)
    return {'api':'ok','database':'ok','worker':'online' if online else 'offline', 'model': w.model if w else {'configured':False}, 'stages': {str(i):'implemented' if i == 1 else 'not_implemented' for i in range(1,5)}}

@app.get('/api/sources')
def sources():
    return [{'source':p.name} for p in sorted(SOURCES.iterdir()) if p.is_dir() and not p.is_symlink() and not p.name.startswith('.')]

@app.post('/api/projects', status_code=201)
def create_project(body:ProjectInput, db=Depends(get_db)):
    if '/' in body.source or body.source.startswith('.'): raise HTTPException(422,'select_a_listed_project')
    safe_path(SOURCES,body.source,True)
    if db.scalar(select(Project).where(Project.source==body.source)): raise HTTPException(409,'project_already_registered')
    p=Project(id=uid('project'),name=body.name.strip(),source=body.source)
    db.add(p);db.commit();return public(p)

@app.get('/api/projects')
def projects(db=Depends(get_db)):
    return [public(p) for p in db.scalars(select(Project).order_by(Project.created_at.desc()))]

@app.get('/api/projects/{pid}')
def project(pid:str,db=Depends(get_db)):
    p=get(db,Project,pid)
    return {**public(p),'snapshots':[public(s) for s in db.scalars(select(Snapshot).where(Snapshot.project_id==pid).order_by(Snapshot.created_at.desc()))]}

@app.post('/api/projects/{pid}/snapshots',status_code=201)
def create_snapshot(pid:str,db=Depends(get_db)):
    p=get(db,Project,pid)
    source=safe_path(SOURCES,p.source,True)
    sid,revision,manifest,size=snapshot_tree(source,SNAPSHOTS)
    snap=Snapshot(id=sid,project_id=pid,revision=revision,files=len(manifest),size=size)
    try:
        directory=RUNS/'snapshots';directory.mkdir(parents=True,exist_ok=True)
        (directory/(sid+'.manifest.json')).write_text(json.dumps({'source_revision':revision,'files':manifest},ensure_ascii=False))
        db.add(snap);db.commit()
    except BaseException:
        db.rollback();shutil.rmtree(SNAPSHOTS/sid,ignore_errors=True)
        (RUNS/'snapshots'/(sid+'.manifest.json')).unlink(missing_ok=True)
        raise
    return public(snap)

@app.get('/api/snapshots/{sid}')
def snapshot(sid:str,db=Depends(get_db)): return public(get(db,Snapshot,sid))

@app.get('/api/snapshots/{sid}/files')
def files(sid:str,prefix:str='',limit:int=100,db=Depends(get_db)):
    get(db,Snapshot,sid)
    if not 1<=limit<=200: raise HTTPException(422,'invalid_limit')
    root=SNAPSHOTS/sid
    results=[]
    # Snapshot trees contain no symlinks and are not writable by the worker.
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.relative_to(root).as_posix().startswith(prefix):
            results.append(path.relative_to(root).as_posix())
            if len(results)>limit: return {'files':results[:limit],'truncated':True}
    return {'files':results,'truncated':False}

@app.get('/api/snapshots/{sid}/evidence')
def evidence(sid:str,file:str,start_line:int=1,end_line:int=20,db=Depends(get_db)):
    get(db,Snapshot,sid)
    return read_evidence(SNAPSHOTS/sid,file,start_line,end_line)

@app.post('/api/jobs',status_code=201)
def create_job(body:ProbeInput,db=Depends(get_db)):
    snap=get(db,Snapshot,body.snapshot_id)
    options = {}
    if body.kind == 'agent_probe':
        if not body.file: raise HTTPException(422, 'probe_file_required')
        read_evidence(SNAPSHOTS/snap.id,body.file,1,1)
    else:
        if set(body.options) - {'include_paths','enrich','base_run_id'}: raise HTTPException(422,'invalid_stage1_options')
        paths = body.options.get('include_paths', [])
        if not isinstance(paths,list) or any(not isinstance(p,str) for p in paths): raise HTTPException(422,'invalid_include_paths')
        for path in paths: safe_path(SNAPSHOTS/snap.id,path,True)
        if not isinstance(body.options.get('enrich',True),bool): raise HTTPException(422,'invalid_enrich_option')
        options = {'include_paths':sorted(set(paths)), 'enrich':body.options.get('enrich',True), 'extractor_version':stage1.EXTRACTOR_VERSION}
        base_id = body.options.get('base_run_id')
        if base_id:
            base = get(db,Job,base_id)
            if base.state not in TERMINAL or base.kind != 'stage1_extract' or base.snapshot_id != snap.id or base.options.get('include_paths',[]) != options['include_paths'] or base.options.get('extractor_version') != stage1.EXTRACTOR_VERSION:
                raise HTTPException(409,'incompatible_base_run')
            options['base_run_id'] = base_id
    j=Job(id=uid('run'),snapshot_id=snap.id,file=body.file or '',kind=body.kind,options=options,state='queued')
    db.add(j);db.flush();event(db,j,'queued',{'kind':body.kind})
    db.commit();return public(j)

@app.get('/api/jobs')
def jobs(project_id:str|None=None,db=Depends(get_db)):
    stale(db);db.commit()
    q=select(Job).join(Snapshot).order_by(Job.created_at.desc()).limit(100)
    if project_id: q=q.where(Snapshot.project_id==project_id)
    return [public(j) for j in db.scalars(q)]

@app.get('/api/jobs/{jid}')
def job(jid:str,db=Depends(get_db)):
    stale(db);db.commit()
    j=get(db,Job,jid)
    response=public(j)
    if j.kind == 'stage1_extract':
        state=db.get(Stage1State,j.id)
        response['analysis']=state.scan if state else None
    return response

@app.post('/api/jobs/{jid}/cancel')
def cancel(jid:str,db=Depends(get_db)):
    j=job_lock(db,jid)
    if j.state=='queued':
        j.state='cancelled';event(db,j,'cancelled')
        if j.kind=='stage1_extract': j.result=stage1.envelope(db,j,True)
    elif j.state=='running': j.state='cancel_requested';event(db,j,'cancel_requested')
    db.commit();return public(j)

@app.get('/api/jobs/{jid}/result')
def result(jid:str,db=Depends(get_db)):
    j=get(db,Job,jid)
    if j.kind == 'stage1_extract' and j.result is None:
        checkpoint=stage1.envelope(db,j,True)
        if checkpoint is not None: return checkpoint
    if j.result is None: raise HTTPException(409,'result_not_available')
    return j.result

@app.get('/api/jobs/{jid}/apis')
def stage_apis(jid:str,q:str='',method:str='',unresolved:bool|None=None,page:int=1,limit:int=50,db=Depends(get_db)):
    j=get(db,Job,jid)
    if j.kind!='stage1_extract': raise HTTPException(422,'not_stage1_job')
    if page<1 or not 1<=limit<=200: raise HTTPException(422,'invalid_pagination')
    rows=[r.record for r in stage1.records(db,jid)]
    rows=[r for r in rows if (not q or q.lower() in (r['path']+' '+r['file']).lower()) and (not method or r['method']==method) and (unresolved is None or bool(r['unresolved'])==unresolved)]
    rows.sort(key=lambda r:(r['file'],r['line'],r['path'],r['method']))
    return {'items':rows[(page-1)*limit:page*limit], 'total':len(rows), 'page':page, 'limit':limit}

@app.get('/api/jobs/{jid}/apis/{aid}')
def stage_api(jid:str,aid:str,db=Depends(get_db)):
    get(db,Job,jid)
    row=db.get(Stage1Api,(jid,aid))
    if not row: raise HTTPException(404,'api_not_found')
    return {'api':row.record,'detail':row.detail}

@app.get('/api/jobs/{jid}/events')
async def events(jid:str,request:Request,after:int=0,last_event_id:str|None=Header(default=None)):
    try: cursor=max(0,after,int(last_event_id or 0))
    except ValueError: raise HTTPException(422,'invalid_event_cursor')
    with Session() as db: get(db,Job,jid)
    async def stream():
        nonlocal cursor
        while not await request.is_disconnected():
            with Session() as db:
                j=get(db,Job,jid)
                rows=db.scalars(select(Event).where(Event.job_id==jid,Event.seq>cursor).order_by(Event.seq).limit(100)).all()
                finished=j.state in TERMINAL
            for e in rows:
                cursor=e.seq
                yield f'id: {e.seq}\nevent: execution\ndata: {json.dumps({"type":e.type,"data":e.data},ensure_ascii=False)}\n\n'
            if finished and len(rows)<100: break
            if not rows: yield ': heartbeat\n\n'
            await asyncio.sleep(1)
    return StreamingResponse(stream(),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

@app.post('/internal/worker/start',dependencies=[Depends(internal)])
def worker_start(body:BootInput,db=Depends(get_db)):
    w=db.get(Worker,body.key)
    if w and w.boot!=body.boot:
        for j in db.scalars(select(Job).where(Job.worker==w.boot,Job.state.in_(['running','cancel_requested'])).with_for_update()).all():
            j.state='cancelled' if j.state=='cancel_requested' else 'failed';j.error='worker_interrupted';event(db,j,'interrupted')
            if j.kind=='stage1_extract': j.result=stage1.envelope(db,j,True)
    if not w: w=Worker(key=body.key,boot=body.boot);db.add(w)
    w.boot=body.boot;w.seen=now();w.model=body.model
    db.commit();return {'ok':True}

def check_worker(db,body):
    w=get(db,Worker,body.key)
    if w.boot!=body.boot: raise HTTPException(409,'worker_superseded')
    w.seen=now()
    return w

def owned(db,jid,body):
    check_worker(db,body)
    j=job_lock(db,jid)
    if j.worker!=body.boot or j.state not in ('running','cancel_requested'): raise HTTPException(409,'job_not_owned')
    j.heartbeat=now()
    return j

@app.post('/internal/jobs/claim',dependencies=[Depends(internal)])
def claim(body:WorkerInput,db=Depends(get_db)):
    check_worker(db,body);stale(db)
    j=db.scalar(select(Job).where(Job.state=='queued').order_by(Job.created_at).with_for_update(skip_locked=True).limit(1))
    if not j: db.commit();return None
    j.state='running';j.worker=body.boot;j.heartbeat=now();event(db,j,'started')
    snap=get(db,Snapshot,j.snapshot_id)
    db.commit();return {**public(j),'source_revision':snap.revision}

@app.post('/internal/jobs/{jid}/heartbeat',dependencies=[Depends(internal)])
def heartbeat(jid:str,body:WorkerInput,db=Depends(get_db)):
    j=owned(db,jid,body);state=j.state;db.commit();return {'state':state}

@app.post('/internal/jobs/{jid}/events',dependencies=[Depends(internal)])
def worker_event(jid:str,body:JobUpdate,db=Depends(get_db)):
    j=owned(db,jid,body)
    if len(json.dumps(body.data))>32000: raise HTTPException(422,'event_too_large')
    event(db,j,body.type,body.data);db.commit();return {'ok':True}

@app.post('/internal/jobs/{jid}/stage1/checkpoints',dependencies=[Depends(internal)])
def checkpoint(jid:str,body:Checkpoint,db=Depends(get_db)):
    j=owned(db,jid,body)
    stage1.save_checkpoint(db,j,body.entries,body.scan,SNAPSHOTS)
    event(db,j,'stage1_checkpoint',{'apis_saved':len(body.entries),'phase':body.scan.get('phase') if body.scan else 'extraction'})
    db.commit();return {'ok':True}

@app.post('/internal/jobs/{jid}/stage1/base',dependencies=[Depends(internal)])
def stage_base(jid:str,body:WorkerInput,db=Depends(get_db)):
    j=owned(db,jid,body)
    rows=stage1.records(db,j.options.get('base_run_id','')) if j.kind=='stage1_extract' else []
    db.commit();return [{'api':r.record,'detail':r.detail} for r in rows]

@app.post('/internal/jobs/{jid}/finish',dependencies=[Depends(internal)])
def finish(jid:str,body:Finish,db=Depends(get_db)):
    j=owned(db,jid,body)
    final_state='cancelled' if j.state=='cancel_requested' else body.state
    if j.kind=='stage1_extract':
        state=db.get(Stage1State,j.id)
        if final_state=='completed' and (not state or not state.scan.get('index_complete')):
            raise HTTPException(422,'stage1_index_not_complete')
        j.result=stage1.envelope(db,j,final_state!='completed')
    elif final_state=='completed':
        if not body.result or body.result.get('kind')!='agent_probe' or not body.result.get('reads'): raise HTTPException(422,'probe_requires_observed_read')
        for e in body.result['reads']:
            read_evidence(SNAPSHOTS/j.snapshot_id,e['file'],e['start_line'],e['end_line'])
        if len(json.dumps(body.result))>65536: raise HTTPException(422,'result_too_large')
    j.state=final_state;j.error=body.error if final_state!='completed' else None
    if j.kind!='stage1_extract': j.result=body.result if final_state=='completed' else None
    event(db,j,final_state,{'code':j.error} if j.error else {})
    if j.result:
        directory=RUNS/j.id;directory.mkdir(parents=True,exist_ok=True)
        name='stage1-result' if j.kind=='stage1_extract' else 'probe-result'
        temp=directory/(name+'.tmp');temp.write_text(json.dumps(j.result,ensure_ascii=False,indent=2));temp.replace(directory/(name+'.json'))
    db.commit();return public(j)
