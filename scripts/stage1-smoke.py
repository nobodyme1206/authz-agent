"""Create and verify a Stage 1 task through HTTP. Model calls require --enrich."""
import argparse,json,time,urllib.request,urllib.parse
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base',default='http://127.0.0.1:3000')
parser.add_argument('--source',default='JeecgBoot')
parser.add_argument('--include',action='append')
parser.add_argument('--enrich',action='store_true')
parser.add_argument('--base-run-id')
parser.add_argument('--timeout',type=int,default=1900)
args=parser.parse_args()
def req(path,body=None):
    request=urllib.request.Request(args.base+'/api'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=30) as response:return json.load(response)
project=next(p for p in req('/projects') if p['source']==args.source)
snapshot=req('/projects/'+project['id'])['snapshots'][0]
options={'include_paths':args.include or ['jeecg-boot'],'enrich':args.enrich}
if args.base_run_id:options['base_run_id']=args.base_run_id
job=req('/jobs',{'kind':'stage1_extract','snapshot_id':snapshot['id'],'options':options})
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/latest-stage1-job.json').write_text(json.dumps({'job_id':job['id'],'snapshot_id':snapshot['id'],'options':options}))
print('submitted',job['id'],flush=True)
start=time.monotonic();previous=None
while time.monotonic()-start<args.timeout:
    job=req('/jobs/'+job['id']);scan=job.get('analysis') or {};state=(job['state'],scan.get('phase'))
    if previous!=state:
        print(json.dumps({'state':job['state'],'phase':scan.get('phase'),'stats':scan.get('stats'),'error':job['error']},ensure_ascii=False),flush=True);previous=state
    if job['state'] in ('completed','failed','cancelled'):break
    time.sleep(1)
result=req('/jobs/'+job['id']+'/result')
assert result['source_revision']==snapshot['revision'] and result['run_id']==job['id'] and result['stage']==1
assert result['schema_version']=='0.4'
apis=result['data']['apis'];assert len({a['api_id'] for a in apis})==len(apis)
for a in apis:
    fields=[(f['location'],f['name']) for f in a['request_fields']]
    assert len(fields)==len(set(fields))
for route,expected in [('/sys/tenant/changeOwenUserTenant',{'userId','tenantId'}),('/sys/sysDepartRole/deptRoleUserAdd',{'userId','newRoleId','oldRoleId'})]:
    matches=[a for a in apis if a['path']==route and a['method']=='POST']
    if matches:
        assert {f['name'] for f in matches[0]['request_fields']}==expected,route
        assert all(f['type']=='string' for f in matches[0]['request_fields']),route
        if 'deptRoleUserAdd' in route:assert all('逗号' in f.get('note','') for f in matches[0]['request_fields'] if f['name'] in ('newRoleId','oldRoleId'))
with urllib.request.urlopen(args.base+'/api/jobs/'+job['id']+'/events?after=1',timeout=30) as response:events=response.read().decode()
assert 'id: 1\n' not in events
assert job['state']=='completed',(job['state'],job['error'])
report={'job_id':job['id'],'snapshot_id':snapshot['id'],'task_state':job['state'],'stage_status':result['status'],'apis':len(apis),'stats':scan.get('stats'),'enrichment':scan.get('enrichment'),'usage':scan.get('usage'),'elapsed_seconds':round(time.monotonic()-start,2),'sse_resume_verified':True}
for name,data in [('result',result),('report',report),('detail',job)]:Path('artifacts/'+job['id']+'-'+name+'.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
