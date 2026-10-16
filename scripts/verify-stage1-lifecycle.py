"""Exercise checkpoint cancellation/restart/resume using deterministic tasks only."""
import argparse,json,subprocess,time,urllib.request
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('reference_job');p.add_argument('--exercise-restart',action='store_true');args=p.parse_args()
assert args.exercise_restart,'This check restarts the worker; pass --exercise-restart explicitly.'
base='http://127.0.0.1:3000/api'
def req(path,body=None):
    request=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=30) as response:return json.load(response)
def wait(job,predicate,seconds=120):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        state=req('/jobs/'+job['id'])
        if predicate(state):return state
        time.sleep(.1)
    raise AssertionError('lifecycle_check_timeout')
reference=req('/jobs/'+args.reference_job);expected=req('/jobs/'+args.reference_job+'/result')
assert not [j for j in req('/jobs') if j['state'] in ('queued','running','cancel_requested')],'wait for active jobs first'
options={'include_paths':reference['options']['include_paths'],'enrich':False}
created=[];report={}
try:
    for mode in ('cancel','restart'):
        job=req('/jobs',{'snapshot_id':reference['snapshot_id'],'kind':'stage1_extract','options':options});created.append(job['id'])
        print(mode,job['id'],flush=True)
        wait(job,lambda j:j['state']=='running' and (j.get('analysis')or{}).get('stats',{}).get('apis_saved',0)>0)
        if mode=='cancel':req('/jobs/'+job['id']+'/cancel',{})
        else:subprocess.run(['docker','compose','restart','agent-worker'],check=True,capture_output=True)
        terminal=wait(job,lambda j:j['state'] in ('failed','cancelled','completed'))
        assert terminal['state']==('cancelled' if mode=='cancel' else 'failed'),terminal['state']
        if mode=='restart':assert terminal['error']=='worker_interrupted'
        partial=req('/jobs/'+job['id']+'/result');assert partial['status']=='partial' and partial['data']['apis']
        report[mode]={'job_id':job['id'],'state':terminal['state'],'error':terminal['error'],'checkpoint_apis':len(partial['data']['apis'])}
        print(json.dumps(report[mode]),flush=True)
    resumed=req('/jobs',{'snapshot_id':reference['snapshot_id'],'kind':'stage1_extract','options':{**options,'base_run_id':job['id']}});created.append(resumed['id'])
    finished=wait(resumed,lambda j:j['state'] in ('completed','failed','cancelled'))
    assert finished['state']=='completed',finished['error']
    output=req('/jobs/'+resumed['id']+'/result')
    assert {a['api_id'] for a in output['data']['apis']}=={a['api_id'] for a in expected['data']['apis']},'unstable_api_ids'
    assert finished['analysis']['usage']['totalTokens']==0,'unexpected_model_call'
    report['resume']={'job_id':resumed['id'],'state':'completed','apis':len(output['data']['apis']),'stable_ids':True,'model_tokens':0}
    print(json.dumps(report['resume']),flush=True)
finally:
    for jid in created:
        j=req('/jobs/'+jid)
        if j['state'] in ('queued','running'):req('/jobs/'+jid+'/cancel',{})
Path('artifacts/stage1-lifecycle.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
