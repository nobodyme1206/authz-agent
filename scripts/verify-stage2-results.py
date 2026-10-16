"""Read-only verification of latest real Stage 2 runs; does not replace semantic human review."""
import argparse,json,urllib.request,hashlib
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--stage1-run',required=True);args=p.parse_args();base='http://127.0.0.1:3000/api'
def get(path):
 with urllib.request.urlopen(base+path,timeout=30) as r:return json.load(r)
gold=json.loads(Path('docs/jeecg-stage2-samples.json').read_text());s1=get('/jobs/'+args.stage1_run+'/result');assert s1['source_revision']==gold['source_revision']
jobs=get('/jobs');report=[];total=0
for sample in gold['samples']:
 api=next(a for a in s1['data']['apis'] if a['method']==sample['method'] and a['path']==sample['path']);chosen=None
 for j in jobs:
  if j['kind']!='stage2_analyze' or j['options'].get('stage1_run_id')!=args.stage1_run or j['options'].get('api_id')!=api['api_id']:continue
  detail=get('/jobs/'+j['id']+'/analysis')['detail']
  if detail.get('usage',{}).get('totalTokens',0)>0 and detail.get('phase')!='checkpoint_replay_for_lifecycle_acceptance':chosen=(j,detail);break
 assert chosen,('missing_live_task',sample['path']);j,detail=chosen;assert j['state']=='completed',(sample['path'],j['id'],j['state'],j['error'])
 a=get('/jobs/'+j['id']+'/analysis');r=get('/jobs/'+j['id']+'/result');assert r['stage']==2 and r['schema_version']=='0.4' and r['data']['api_id']==api['api_id'];assert a['source']['api']==api
 actual_hash=hashlib.sha256(json.dumps(a['source'],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest();assert actual_hash==a['input_hash']==j['options']['input_hash']
 data=r['data'];fields={f['location']+':'+f['name'] for f in api['request_fields']};ops=data.get('operations') or [data['operation']];op_ids={o['id'] for o in ops if 'id' in o}
 reads=detail.get('agent_observed')
 if reads is None:
  # Exclude program-only navigation locations from historical pre-release proof.
  reads=list(detail['observed']);removed=set()
  for candidate in [c for c in detail.get('candidates',[]) if c['kind']=='operation'][:30]:
   key=json.dumps([candidate['evidence'],candidate['description']],sort_keys=True)
   if key not in removed and candidate['evidence'] in reads:reads.remove(candidate['evidence'])
   removed.add(key)
 for c in data['checks']:
  assert set(c['fields'])<=fields;assert set(c.get('operation_ids',[]))<=op_ids
 for item in data['checks']+ops:
  assert item['evidence']
  for ev in item['evidence']:
   assert not ev['file'].startswith('/') and '..' not in ev['file'].split('/')
   cursor=ev['start_line']
   for seen in sorted((s for s in reads if s['file']==ev['file']),key=lambda s:s['start_line']):
    if seen['start_line']>cursor:break
    if seen['end_line']>=cursor:cursor=seen['end_line']+1
   assert cursor>ev['end_line'],('unread_evidence',ev)
   import urllib.parse
   code=get('/snapshots/'+j['snapshot_id']+'/evidence?'+urllib.parse.urlencode(ev));assert code['content']
 raw=urllib.request.urlopen(base+'/jobs/'+j['id']+'/events',timeout=30).read().decode();events=[];seq=[]
 for block in raw.split('\n\n'):
  for line in block.splitlines():
   if line.startswith('id: '):seq.append(int(line[4:]))
   if line.startswith('data: '):events.append(json.loads(line[6:]))
 assert seq==sorted(set(seq));assert any(e['type']=='tool_started' for e in events);assert any(e['type']=='model_turn' for e in events);assert detail['analysis_complete']
 count=sum(e['type']=='tool_started' for e in events);total+=detail['usage']['totalTokens']
 report.append({'method':sample['method'],'path':sample['path'],'job_id':j['id'],'status':r['status'],'operations':len(ops),'checks':len(data['checks']),'unresolved':len(data['unresolved']),'tool_calls':count,'tokens':detail['usage']['totalTokens']})
Path('artifacts/stage2-verified-runs.json').write_text(json.dumps({'source_stage1':args.stage1_run,'results':report,'tokens':total,'semantic_review':'See docs/acceptance-batch3.md; structural verification does not prove policy semantics.'},ensure_ascii=False,indent=2))
print(json.dumps({'verified_real_apis':len(report),'tokens':total,'results':report},ensure_ascii=False,indent=2))
