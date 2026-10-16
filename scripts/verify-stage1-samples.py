"""Compare an existing Stage 1 result with 20 manually reviewed JeecgBoot bindings."""
import argparse,json,urllib.request
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('job_id');p.add_argument('--base',default='http://127.0.0.1:3000');args=p.parse_args()
with urllib.request.urlopen(args.base+'/api/jobs/'+args.job_id+'/result',timeout=30) as r:result=json.load(r)
golden=json.loads((Path(__file__).resolve().parents[1]/'docs/jeecg-stage1-samples.json').read_text())
assert result['source_revision']==golden['source_revision'],'sample_snapshot_mismatch'
report=[]
for sample in golden['samples']:
    matches=[a for a in result['data']['apis'] if a['path']==sample['path'] and a['method']==sample['method']]
    assert len(matches)==1,(sample['path'],'missing_or_ambiguous_api')
    api=matches[0];actual=sorted(f['location']+':'+f['name']+':'+str(f['type']) for f in api['request_fields'])
    missing=sorted(set(sample['fields'])-set(actual));extra=sorted(set(actual)-set(sample['fields']))
    report.append({'path':sample['path'],'method':sample['method'],'fields':len(actual),'missing':missing,'extra':extra,'unresolved':api['unresolved'],'entry':{'file':api['file'],'line':api['line']}})
    assert not missing and not extra,(sample['path'],{'missing':missing,'extra':extra})
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/'+args.job_id+'-sample-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'job_id':args.job_id,'reviewed_apis':len(report),'reviewed_bindings':sum(x['fields'] for x in report),'missing':0,'extra':0},ensure_ascii=False,indent=2))
