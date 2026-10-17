"""Read-only structural review of exact frozen first attempts, never 'latest successful' runs.
This report is NOT a semantic pass certificate. Human review must include all failed tasks.
"""
import argparse,json,hashlib,urllib.request,urllib.parse
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest');a=p.parse_args();m=json.loads(Path(a.manifest).read_text());attempts=json.loads(Path(a.manifest).with_name(Path(a.manifest).stem+'-attempts.json').read_text())['attempts'];root=Path('artifacts')/m['acceptance_id'];report=[]
def covers(e,seen):
 c=e['start_line']
 for r in sorted((r for r in seen if r['file']==e['file']),key=lambda r:r['start_line']):
  if r['start_line']>c:break
  if r['end_line']>=c:c=r['end_line']+1
 return c>e['end_line']
for i,entry in enumerate(m['entries']):
 t=next((t for t in attempts if t['index']==i),None)
 row={'index':i,'group':entry['group'],'path':entry['path'],'state':'not_submitted','semantic_review':'required'}
 if not t or not t.get('finished'):report.append(row);continue
 raw=json.loads((root/(t['job_id']+'.json')).read_text());d=raw['analysis']['detail'];r=raw['result'];issues=[];events=[json.loads(l[6:])for l in raw['events'].splitlines()if l.startswith('data: ')]
 row.update({k:t.get(k)for k in ['job_id','state','status','tokens','error']});row['checkpoint_tokens']=row['tokens'];event_usage=[e['data']['usage']['totalTokens']for e in events if e['type']=='model_turn'];row['tokens']=max(event_usage or [row['tokens'] or 0]);row['usage_checkpoint_disagreement']=row['tokens']!=row['checkpoint_tokens'];row.update({'tool_events':sum(e['type']=='tool_started'for e in events),'model_turns':d.get('turns',0),'analysis_complete':d.get('analysis_complete',False)})
 if raw['analysis']['input_hash']!=entry['input_hash']:issues.append('input_hash_mismatch')
 if not row['tool_events']:issues.append('no_real_tool_event')
 if r:
  data=r['data'];ops=data.get('operations')or[data['operation']];refs={o['id']for o in ops if'id'in o}
  for c in data['checks']:
   if len(ops)>1 and not c.get('operation_ids'):issues.append('missing_operation_refs')
   if set(c.get('operation_ids',[]))-refs:issues.append('bad_operation_refs')
   if'jwt'in c['rule'].lower()and d.get('obligations',{}).get('conditions')and not c.get('conditions'):issues.append('jwt_conditions_missing')
  for item in ops+data['checks']:
   for e in item['evidence']:
    if not covers(e,d.get('agent_observed',[])):issues.append('unread_evidence')
    url='http://127.0.0.1:3000/api/snapshots/'+raw['job']['snapshot_id']+'/evidence?'+urllib.parse.urlencode(e)
    with urllib.request.urlopen(url,timeout=30)as q:assert json.load(q)['content']
  mandatory=set(d.get('audit',{}).get('mandatory_unresolved',[]))
  if mandatory-set(data['unresolved']):issues.append('mandatory_unknown_dropped')
  row.update({'operations':len(ops),'checks':len(data['checks']),'unresolved':len(data['unresolved']),'unconfirmed':len(d.get('audit',{}).get('unconfirmed_checks',[]))})
 else:issues.append('no_valid_result')
 row['structural_issues']=sorted(set(issues));report.append(row)
out={'acceptance_id':m['acceptance_id'],'first_attempts':report,'tokens':sum(t.get('tokens',0)for t in report),'checkpoint_tokens':sum(t.get('tokens',0)for t in attempts),'semantic_status':'requires independent source review, including failed/partial tasks'};root.mkdir(exist_ok=True,parents=True);(root/'structural-review.json').write_text(json.dumps(out,ensure_ascii=False,indent=2));print(json.dumps(out,ensure_ascii=False,indent=2))
