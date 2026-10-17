"""Replay an existing real checkpoint to test HTTP ownership/cancel/restart without paid calls.
Stops the idle Worker; --exercise-restart is required. This is protocol acceptance, not an Agent run.
"""
import argparse,copy,json,subprocess,time,urllib.request,urllib.error,uuid
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('reference_job');p.add_argument('--exercise-restart',action='store_true');p.add_argument('--output',default='artifacts/stage2-lifecycle.json');args=p.parse_args();assert args.exercise_restart
base='http://127.0.0.1:3000';boot='checkpoint-replay-'+uuid.uuid4().hex

def request(route,body=None,internal=False):
 headers={'Content-Type':'application/json'}
 if internal:
  # Internal endpoints deliberately have no Web proxy or host port. Read the secret only inside API.
  code='''import json,sys,os,urllib.request,urllib.error
from pathlib import Path
p=json.load(sys.stdin);token=Path(os.environ['INTERNAL_TOKEN_FILE']).read_text().strip()
r=urllib.request.Request('http://127.0.0.1:8000'+p['route'],data=json.dumps(p['body']).encode(),headers={'Content-Type':'application/json','X-Worker-Token':token})
try:
 with urllib.request.urlopen(r,timeout=30) as q: print(json.dumps({'status':q.status,'data':json.load(q)}))
except urllib.error.HTTPError as e: print(json.dumps({'status':e.code,'data':json.load(e)}))
'''
  out=subprocess.run(['docker','compose','exec','-T','api','python','-c',code],input=json.dumps({'route':route,'body':{'boot':boot,**(body or {})}}),text=True,capture_output=True,check=True)
  value=json.loads(out.stdout)
  if value['status']>=400:raise urllib.error.HTTPError(route,value['status'],str(value['data']),None,None)
  return value['data']
 r=urllib.request.Request(base+route,data=None if body is None else json.dumps(body).encode(),headers=headers)
 with urllib.request.urlopen(r,timeout=30) as response:return json.load(response)

reference=request('/api/jobs/'+args.reference_job);assert reference['state'] in ('completed','failed','cancelled') and reference['kind']=='stage2_analyze'
analysis=request('/api/jobs/'+args.reference_job+'/analysis');result=request('/api/jobs/'+args.reference_job+'/result')
assert not [j for j in request('/api/jobs') if j['state'] in ('queued','running','cancel_requested')],'active jobs: do not interrupt research tasks'
report={'reference':reference['id'],'mode':'replay_of_real_checkpoint_no_model_calls'};created=[]
subprocess.run(['docker','compose','stop','agent-worker'],check=True,capture_output=True)
try:
 request('/internal/worker/start',{'model':{'configured':False,'state':'protocol_acceptance_only'}},True)
 def create_and_replay():
  j=request('/api/jobs',{'kind':'stage2_analyze','snapshot_id':reference['snapshot_id'],'options':{'stage1_run_id':reference['options']['stage1_run_id'],'api_id':reference['options']['api_id'],'base_run_id':reference['id']}});created.append(j['id'])
  claim=request('/internal/jobs/claim',{},True);assert claim['id']==j['id']
  ctx=request('/internal/jobs/'+j['id']+'/stage2/context',{},True);assert ctx['base']['data']==result['data']
  detail=copy.deepcopy(analysis['detail']);detail.update({'phase':'checkpoint_replay_for_lifecycle_acceptance','analysis_complete':False,'input_hash':ctx['input_hash'],'usage':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'totalTokens':0}})
  request('/internal/jobs/'+j['id']+'/stage2/checkpoints',{'data':result['data'],'detail':detail},True)
  return j,detail
 j,_=create_and_replay();request('/api/jobs/'+j['id']+'/cancel',{});assert request('/internal/jobs/'+j['id']+'/heartbeat',{},True)['state']=='cancel_requested'
 request('/internal/jobs/'+j['id']+'/finish',{'state':'cancelled','error':'cancelled_by_user'},True);out=request('/api/jobs/'+j['id']+'/result');assert out['status']=='partial' and out['data']==result['data']
 report['cancel']={'job_id':j['id'],'checkpoint_retained':True};j,detail=create_and_replay()
finally:subprocess.run(['docker','compose','start','agent-worker'],check=True,capture_output=True)
end=time.monotonic()+45
while time.monotonic()<end:
 state=request('/api/jobs/'+j['id'])
 if state['state']=='failed':break
 time.sleep(.5)
assert state['error']=='worker_interrupted';assert request('/api/jobs/'+j['id']+'/result')['data']==result['data']
try:request('/internal/jobs/'+j['id']+'/stage2/checkpoints',{'data':result['data'],'detail':detail},True);raise AssertionError('late checkpoint accepted')
except urllib.error.HTTPError as e:assert e.code==409
report['restart']={'job_id':j['id'],'checkpoint_retained':True,'late_write_rejected':True}
# Create then cancel a queued continuation, proving reuse checks without spending model budget.
subprocess.run(['docker','compose','stop','agent-worker'],check=True,capture_output=True)
try:
 continued=request('/api/jobs',{'kind':'stage2_analyze','snapshot_id':reference['snapshot_id'],'options':{'stage1_run_id':reference['options']['stage1_run_id'],'api_id':reference['options']['api_id'],'base_run_id':j['id']}})
 assert request('/api/jobs/'+continued['id']+'/cancel',{})['state']=='cancelled';report['compatible_continuation']={'job_id':continued['id'],'created':True,'cancelled_before_model':True}
finally:subprocess.run(['docker','compose','start','agent-worker'],check=True,capture_output=True)
Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2))
