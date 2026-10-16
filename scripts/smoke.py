"""HTTP smoke test; never invokes a vulnerability request or a live model without configuration."""
import argparse,json,time,urllib.request,urllib.error
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--base',default='http://127.0.0.1:3000')
parser.add_argument('--source',default='JeecgBoot')
args=parser.parse_args()
def req(path,body=None):
    r=urllib.request.Request(args.base+'/api'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(r,timeout=240) as response:return json.load(response)
health=req('/health')
project=next((p for p in req('/projects') if p['source']==args.source),None)
if not project:project=req('/projects',{'name':args.source,'source':args.source})
detail=req('/projects/'+project['id'])
snapshot=detail['snapshots'][0] if detail['snapshots'] else req('/projects/'+project['id']+'/snapshots',{})
# Always verify source evidence. With a configured model, this script deliberately
# avoids issuing paid calls; submit the explicit probe task from the UI instead.
evidence=req('/snapshots/'+snapshot['id']+'/evidence?file=README.md&start_line=1&end_line=1')
report={'health':health,'project_id':project['id'],'snapshot_id':snapshot['id'],'source_revision':snapshot['revision'],'evidence_read':bool(evidence['content'])}
if not health['model']['configured']:
    job=req('/jobs',{'snapshot_id':snapshot['id'],'file':'README.md'})
    for _ in range(40):
        job=req('/jobs/'+job['id'])
        if job['state'] in ('completed','failed','cancelled'):break
        time.sleep(.5)
    assert job['state']=='failed' and job['error']=='model_not_configured',job
    with urllib.request.urlopen(args.base+'/api/jobs/'+job['id']+'/events?after=1',timeout=10) as r:stream=r.read().decode()
    assert 'id: 1\n' not in stream and 'failed' in stream
    report.update(model_missing_handled=True,sse_resume=True,job_id=job['id'])
else:report['model_probe']='not_run_by_smoke_script'
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/smoke.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
