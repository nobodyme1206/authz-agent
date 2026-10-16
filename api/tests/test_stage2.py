import copy
from app.db import Session, Job, Stage1Api, Stage2State
from app.stage2 import ANALYZER_VERSION
from test_stage1 import client, setup, create, entry, checkpoint, H


def source(c):
    _,snap=setup(c);j=create(c,snap);e=entry(snap,unresolved=['dynamic input'])
    assert checkpoint(c,j,[e]).status_code==200
    assert c.post('/internal/jobs/'+j['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'}).status_code==200
    return snap,j,e


def start(c,s,j,e,**extra):
    r=c.post('/api/jobs',json={'kind':'stage2_analyze','snapshot_id':s['id'],'options':{'stage1_run_id':j['id'],'api_id':e['api']['api_id'],**extra}})
    assert r.status_code==201,r.text
    new=r.json();assert c.post('/internal/jobs/claim',headers=H,json={'boot':'stage-boot'}).json()['id']==new['id']
    ctx=c.post('/internal/jobs/'+new['id']+'/stage2/context',headers=H,json={'boot':'stage-boot'}).json()
    return new,ctx


def payload(e,ctx):
    ev={'file':'A.java','start_line':1,'end_line':1}
    data={'api_id':e['api']['api_id'],'operation':{'description':'Update requested resource','evidence':[ev]},'checks':[{'id':'c1','fields':['body:id'],'rule':'The target user must belong to the tenant, not the requesting principal.','evidence':[ev]}],'scope':['A.java:1'],'unresolved':['Stage 1: dynamic input']}
    detail={'analyzer_version':ANALYZER_VERSION,'input_hash':ctx['input_hash'],'phase':'finished','analysis_complete':True,'observed':[ev],'mandatory_unresolved':[]}
    return {'boot':'stage-boot','data':data,'detail':detail}


def test_stage2_freezes_input_and_result_contract(client):
    s,j,e=source(client);new,ctx=start(client,s,j,e)
    with Session() as db:
        row=db.get(Stage1Api,(j['id'],e['api']['api_id']));changed=copy.deepcopy(row.record);changed['request_fields']=[];row.record=changed;db.commit()
    read=client.post('/internal/jobs/'+new['id']+'/stage2/context',headers=H,json={'boot':'stage-boot'}).json()
    assert read['source']==ctx['source'] and read['input_hash']==ctx['input_hash']
    p=payload(e,ctx);assert client.post('/internal/jobs/'+new['id']+'/stage2/checkpoints',headers=H,json=p).status_code==200
    assert client.post('/internal/jobs/'+new['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'}).status_code==200
    out=client.get('/api/jobs/'+new['id']+'/result').json()
    assert out['stage']==2 and out['schema_version']=='0.4' and out['status']=='partial'
    assert out['data']['checks'][0]['fields']==['body:id']
    assert client.get('/api/jobs/'+new['id']+'/analysis').json()['input_hash']==ctx['input_hash']
    assert client.get('/api/jobs/'+new['id']).json()['result'] is None
    invalid=client.post('/api/jobs',json={'kind':'stage2_analyze','snapshot_id':s['id'],'options':{'stage1_run_id':j['id'],'api_id':e['api']['api_id'],'base_run_id':new['id']}})
    assert invalid.status_code==409  # source changed: hash prevents accidental reuse


def test_stage2_rejects_bad_fields_evidence_versions_and_late_writes(client):
    s,j,e=source(client);new,ctx=start(client,s,j,e);route='/internal/jobs/'+new['id']+'/stage2/checkpoints';p=payload(e,ctx)
    cases=[]
    a=copy.deepcopy(p);a['data']['checks'][0]['fields']=['body:made_up'];cases.append(a)
    a=copy.deepcopy(p);a['data']['checks'][0]['evidence'][0]['file']='../secret';cases.append(a)
    a=copy.deepcopy(p);a['detail']['observed']=[];cases.append(a)
    a=copy.deepcopy(p);a['detail']['input_hash']='other';cases.append(a)
    a=copy.deepcopy(p);a['data']['unresolved']=[];cases.append(a)
    a=copy.deepcopy(p);a['data']['checks'][0]['evidence']=[];cases.append(a)
    for a in cases:assert client.post(route,headers=H,json=a).status_code==422
    assert client.post(route,headers=H,json=p).status_code==200
    client.post('/api/jobs/'+new['id']+'/cancel')
    client.post('/internal/jobs/'+new['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'})
    assert client.get('/api/jobs/'+new['id']+'/result').json()['status']=='partial'
    assert client.post(route,headers=H,json=p).status_code==409
    resumed,rctx=start(client,s,j,e,base_run_id=new['id'])
    assert rctx['base']['data']==p['data']
    client.post('/internal/worker/start',headers=H,json={'boot':'new-boot'})
    assert client.get('/api/jobs/'+resumed['id']).json()['error']=='worker_interrupted'


def test_stage2_requires_terminal_source_and_real_result(client):
    _,s=setup(client);j=create(client,s);e=entry(s);checkpoint(client,j,[e])
    body={'kind':'stage2_analyze','snapshot_id':s['id'],'options':{'stage1_run_id':j['id'],'api_id':e['api']['api_id']}}
    assert client.post('/api/jobs',json=body).status_code==409
    client.post('/internal/jobs/'+j['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'})
    new,ctx=start(client,s,j,e)
    assert client.get('/api/jobs/'+new['id']+'/result').status_code==409
    assert client.post('/internal/jobs/'+new['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'}).status_code==422
    p=payload(e,ctx);p['data']['unresolved']=[]
    assert client.post('/internal/jobs/'+new['id']+'/stage2/checkpoints',headers=H,json=p).status_code==200
    client.post('/internal/jobs/'+new['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'})
    assert client.get('/api/jobs/'+new['id']+'/result').json()['status']=='completed'


def test_evidence_proof_supports_contiguous_reads_but_not_gaps():
    from app.stage2 import was_read
    ev={'file':'A.java','start_line':79,'end_line':102}
    assert was_read(ev,[{'file':'A.java','start_line':1,'end_line':100},{'file':'A.java','start_line':99,'end_line':112}])
    assert not was_read(ev,[{'file':'A.java','start_line':1,'end_line':90},{'file':'A.java','start_line':92,'end_line':112}])
