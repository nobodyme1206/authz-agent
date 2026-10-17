"""Immutable first-attempt acceptance: 10 JeecgBoot APIs + 8 source-only semantic controls.
prepare performs deterministic extraction only; execute makes at most 18 paid Stage 2 jobs.
No automatic retry. Expectations never enter job options or Worker snapshots.
"""
import argparse,hashlib,json,os,shutil,subprocess,time,urllib.request,urllib.error,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];BASE='http://127.0.0.1:3000/api'
def get(route,body=None):
    r=urllib.request.Request(BASE+route,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(r,timeout=40) as q:return json.load(q)
def digest(data):return hashlib.sha256(json.dumps(data,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def command(*args):return subprocess.check_output(args,text=True,cwd=ROOT).strip()
def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2));temp.replace(path)
def fingerprint():
    code="""import fs from 'node:fs';import crypto from 'node:crypto';import {systemPrompt}from './src/stage2.ts';const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const limits=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('STAGE2_')));console.log(JSON.stringify({build:JSON.parse(fs.readFileSync('/app/build.json')),prompt_sha256:hash(systemPrompt),lock_sha256:hash(fs.readFileSync('package-lock.json')),limits}));"""
    info=json.loads(command('docker','compose','exec','-T','agent-worker','node','--import','tsx','--input-type=module','-e',code))
    info['images']={}
    for service in ['api','agent-worker','web']:
        cid=command('docker','compose','ps','-q',service);info['images'][service]=json.loads(command('docker','inspect',cid))[0]['Image']
    info['model']=get('/health')['model'];return info
def wait(j):
    end=time.monotonic()+650;last=None
    while time.monotonic()<end:
        state=get('/jobs/'+j['id']);phase=(state['state'],(state.get('analysis')or{}).get('phase'))
        if phase!=last:print(json.dumps({'job_id':j['id'],'state':state['state'],'phase':phase[1]},ensure_ascii=False),flush=True);last=phase
        if state['state']in ['completed','failed','cancelled']:return state
        time.sleep(2)
    raise RuntimeError('acceptance_poll_deadline_no_automatic_resubmission')
def stage1(snapshot,paths):
    j=wait(get('/jobs',{'kind':'stage1_extract','snapshot_id':snapshot,'options':{'include_paths':paths,'enrich':False}}))
    assert j['state']=='completed',j;return j['id'],get('/jobs/'+j['id']+'/result')
def source_projects():return get('/projects')
def project(source,name):
    found=[p for p in source_projects()if p['source']==source]
    return found[0]if found else get('/projects',{'source':source,'name':name})
def prepare(path):
    assert not Path(path).exists(),'manifest already exists'
    assert command('git','status','--porcelain')=='','commit implementation before freezing acceptance'
    fp=fingerprint();head=command('git','rev-parse','HEAD');assert fp['build']['commit']==head,'rebuild Worker with BUILD_COMMIT=HEAD'
    assert fp['model']['configured'],'model not configured'
    assert not [j for j in get('/jobs')if j['state']in ['queued','running','cancel_requested']],'active jobs'
    source=ROOT/'evaluation/control-sources';dest=ROOT.parent/'project/AuthzControls'
    for f in sorted(source.rglob('*')):
        if f.is_file():
            target=dest/f.relative_to(source);target.parent.mkdir(parents=True,exist_ok=True)
            if target.exists():assert target.read_bytes()==f.read_bytes(),'existing control source differs'
            else:shutil.copyfile(f,target)
    assert all(p.suffix=='.java' for p in dest.rglob('*')if p.is_file()),'only Java source may be exported'
    ctrl=project('AuthzControls','Authz Controls');snap=get('/projects/'+ctrl['id']+'/snapshots',{})
    fixture_run,fixtures=stage1(snap['id'],[])
    s1_run,jeecg=stage1('snap-4a6084f0a6b24b9daa7446f23b873d27',['jeecg-boot'])
    expected=json.loads((ROOT/'docs/jeecg-stage2-samples.json').read_text());assert jeecg['source_revision']==expected['source_revision']
    entries=[]
    groups=[('jeecg',expected['samples'],s1_run,jeecg),('control',json.loads((ROOT/'evaluation/control-expectations.json').read_text())['cases'],fixture_run,fixtures)]
    for group,samples,run,result in groups:
        for sample in samples:
            matches=[a for a in result['data']['apis']if a['method']==sample['method']and a['path']==sample['path']];assert len(matches)==1,sample
            api=matches[0];raw=get('/jobs/'+run+'/apis/'+api['api_id']);entries.append({'group':group,'method':api['method'],'path':api['path'],'api_id':api['api_id'],'stage1_run_id':run,'snapshot_id':get('/jobs/'+run)['snapshot_id'],'source_revision':result['source_revision'],'input_hash':digest(raw)})
    m={'acceptance_id':'hardening-'+uuid.uuid4().hex,'git_commit':head,'fingerprint':fp,'analyzer_version':'authz-java-1.1.0','stage1_runs':{'jeecg':s1_run,'controls':fixture_run},'jeecg_expectations_sha256':hashlib.sha256((ROOT/'docs/jeecg-stage2-samples.json').read_bytes()).hexdigest(),'expectations_sha256':hashlib.sha256((ROOT/'evaluation/control-expectations.json').read_bytes()).hexdigest(),'entries':entries}
    assert len(entries)==18;write(path,m);print(json.dumps({'manifest':str(path),'acceptance_id':m['acceptance_id'],'jobs':len(entries),'stage1_runs':m['stage1_runs']},ensure_ascii=False),flush=True)
def execute(path):
    m=json.loads(Path(path).read_text());statepath=Path(path).with_name(Path(path).stem+'-attempts.json');state=json.loads(statepath.read_text())if statepath.exists()else {'acceptance_id':m['acceptance_id'],'attempts':[]}
    assert fingerprint()==m['fingerprint'],'execution environment changed'
    assert command('git','rev-parse','HEAD')==m['git_commit'] and not command('git','status','--porcelain'),'code changed after freeze'
    for n,entry in enumerate(m['entries']):
        existing=next((a for a in state['attempts']if a['index']==n),None)
        if existing:
            assert existing.get('finished'),'an attempt was interrupted; inspect it rather than resubmit'
            continue
        assert fingerprint()==m['fingerprint'],'execution environment changed between jobs'
        attempt={'index':n,'entry':entry,'submission_intent':True,'finished':False};state['attempts'].append(attempt);write(statepath,state)
        # Save intent before POST so a lost connection never causes a hidden duplicate model call.
        job=get('/jobs',{'kind':'stage2_analyze','snapshot_id':entry['snapshot_id'],'options':{'stage1_run_id':entry['stage1_run_id'],'api_id':entry['api_id']}})
        assert job['options']['input_hash']==entry['input_hash'];attempt['job_id']=job['id'];write(statepath,state)
        j=wait(job);analysis=get('/jobs/'+j['id']+'/analysis')
        try:result=get('/jobs/'+j['id']+'/result')
        except urllib.error.HTTPError as e:
            if e.code!=409:raise
            result=None
        raw=urllib.request.urlopen(BASE+'/jobs/'+j['id']+'/events',timeout=40).read().decode()
        write(ROOT/'artifacts'/m['acceptance_id']/(j['id']+'.json'),{'job':j,'analysis':analysis,'result':result,'events':raw})
        execution=analysis['detail'].get('execution',{});assert execution.get('build')==m['fingerprint']['build'];assert execution.get('prompt_sha256')==m['fingerprint']['prompt_sha256'];assert execution.get('lock_sha256')==m['fingerprint']['lock_sha256']
        attempt.update({'finished':True,'state':j['state'],'error':j.get('error'),'phase':analysis['detail'].get('phase'),'status':result['status']if result else None,'tokens':analysis['detail'].get('usage',{}).get('totalTokens',0)});write(statepath,state)
        print(json.dumps({'first_attempt':n+1,'of':18,'path':entry['path'],**{k:attempt[k]for k in ['job_id','state','status','tokens','error']}},ensure_ascii=False),flush=True)
        if j.get('error')in ['model_authentication_failed','model_usage_unavailable','model_not_configured']:raise RuntimeError('global_model_failure_remaining_jobs_not_submitted')
    print(json.dumps({'acceptance_id':m['acceptance_id'],'attempts':len(state['attempts']),'tokens':sum(a.get('tokens',0)for a in state['attempts'])},ensure_ascii=False))
p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['prepare','execute']);p.add_argument('manifest');args=p.parse_args()
if args.mode=='prepare':prepare(Path(args.manifest))
else:execute(Path(args.manifest))
