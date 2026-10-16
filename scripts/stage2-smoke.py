"""Explicit Stage 2 paid acceptance. Select one sample or all ten; no retries."""
import argparse,json,time,urllib.request
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--stage1-run',required=True);p.add_argument('--sample',type=int,default=1);p.add_argument('--all',action='store_true');p.add_argument('--samples',help='Explicit comma-separated sample numbers');p.add_argument('--base-run',help='Explicit compatible checkpoint for one API');args=p.parse_args()
base='http://127.0.0.1:3000/api'
def req(path,body=None):
 r=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(r,timeout=30) as response:return json.load(response)
root=Path(__file__).resolve().parents[1];gold=json.loads((root/'docs/jeecg-stage2-samples.json').read_text());source=req('/jobs/'+args.stage1_run);apis=req('/jobs/'+args.stage1_run+'/result');assert apis['source_revision']==gold['source_revision']
selected=[gold['samples'][int(n)-1] for n in args.samples.split(',')] if args.samples else gold['samples'] if args.all else [gold['samples'][args.sample-1]];reports=[]
assert not args.base_run or len(selected)==1,'continuation accepts one API'
for sample in selected:
 matches=[a for a in apis['data']['apis'] if a['method']==sample['method'] and a['path']==sample['path']];assert len(matches)==1,sample
 a=matches[0];options={'stage1_run_id':source['id'],'api_id':a['api_id']}
 if args.base_run:options['base_run_id']=args.base_run
 j=req('/jobs',{'kind':'stage2_analyze','snapshot_id':source['snapshot_id'],'options':options});print('submitted',sample['method'],sample['path'],j['id'],flush=True)
 Path('artifacts').mkdir(exist_ok=True);Path('artifacts/latest-stage2-job.json').write_text(json.dumps({'job_id':j['id'],'sample':args.sample,'path':sample['path']}))
 deadline=time.monotonic()+360;seen=None
 while time.monotonic()<deadline:
  j=req('/jobs/'+j['id']);phase=(j['state'],(j.get('analysis')or{}).get('phase'))
  if phase!=seen: print(json.dumps({'job':j['id'],'state':j['state'],'phase':(j.get('analysis')or{}).get('phase'),'usage':(j.get('analysis')or{}).get('usage'),'error':j.get('error')},ensure_ascii=False),flush=True);seen=phase
  if j['state'] in ('completed','failed','cancelled'):break
  time.sleep(2)
 detail=req('/jobs/'+j['id']+'/analysis')
 try:result=req('/jobs/'+j['id']+'/result')
 except Exception:result=None
 events=urllib.request.urlopen(base+'/jobs/'+j['id']+'/events',timeout=30).read().decode()
 report={'sample':sample,'job':j,'result':result,'analysis':detail,'events':events}
 Path('artifacts/'+j['id']+'-stage2.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));reports.append({'path':sample['path'],'job_id':j['id'],'state':j['state'],'status':result['status'] if result else None,'usage':(j.get('analysis')or{}).get('usage')})
 print('finished',json.dumps(reports[-1],ensure_ascii=False),flush=True)
Path('artifacts/latest-stage2-runs.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2))
