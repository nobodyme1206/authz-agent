"""Generate v0.4 validation contracts without adding required analysis fields."""
import json, re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
S={'type':'string','minLength':1}
strings={'type':'array','items':S}
def obj(properties,required=None):
 return {'type':'object','properties':properties,'required':list(properties) if required is None else required,'additionalProperties':False}
def arr(items): return {'type':'array','items':items}
evidence=obj({'file':S,'start_line':{'type':'integer','minimum':1},'end_line':{'type':'integer','minimum':1}})
ev=arr(evidence)
field=obj({'name':S,'location':{'enum':['body','query','path','form','header']},'type':{'type':['string','null']},'note':S,'evidence':ev},['name','location','type'])
api=obj({'api_id':S,'method':{'enum':['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE']},'path':S,'file':S,'line':{'type':'integer','minimum':1},'request_fields':arr(field),'unresolved':strings})
operation=obj({'id':S,'description':S,'evidence':ev},['description','evidence'])
# Optional bindings remain descriptive: the approved baseline does not define a fixed mapping language.
bindings=arr({'type':'object'})
check=obj({'id':S,'fields':strings,'rule':S,'evidence':ev,'conditions':strings,'bindings':bindings,'operation_ids':strings},['id','fields','rule','evidence'])
trace={'oneOf':[strings,arr(obj({'from':S,'to':S,'evidence':ev}))]}
req=obj({'id':S,'fields':strings,'rule':S,'basis':{'enum':['explicit','inferred']},'evidence':ev,'conditions':strings,'trace':trace,'bindings':bindings,'operation_ids':strings},['id','fields','rule','basis','evidence'])
comp=obj({'requirement_id':S,'check_ids':strings,'result':{'enum':['covered','potential_gap','unknown']},'reason':S,'operation_id':S,'scenario':S,'unresolved':strings},['requirement_id','check_ids','result','reason'])
s2=obj({'api_id':S,'operation':operation,'operations':arr({**operation,'required':['id','description','evidence']}),'checks':arr(check),'scope':strings,'unresolved':strings},['api_id','checks','scope','unresolved'])
s2['oneOf']=[{'required':['operation'],'not':{'required':['operations']}},{'required':['operations'],'not':{'required':['operation']}}]
data=[obj({'apis':arr(api)}),s2,obj({'api_id':S,'requirements':arr(req),'unresolved':strings}),obj({'api_id':S,'comparisons':arr(comp),'unresolved':strings})]
for i,d in enumerate(data,1):
 envelope=obj({'schema_version':{'const':'0.4'},'project_id':S,'source_revision':S,'run_id':S,'stage':{'const':i},'status':{'enum':['completed','partial','failed']},'data':d})
 envelope['$schema']='https://json-schema.org/draft/2020-12/schema'
 (root/'contracts'/f'stage-{i}.schema.json').write_text(json.dumps(envelope,ensure_ascii=False,indent=2)+'\n')
(root/'contracts'/'evidence.schema.json').write_text(json.dumps(evidence,indent=2)+'\n')
text=(root/'docs'/'approved-v0.4.txt').read_text()
blocks=[json.loads(s) for s in re.findall(r'```json\n(.*?)\n```',text,re.S)]
(root/'contracts'/'examples').mkdir(exist_ok=True)
for i,key in enumerate(['apis','checks','requirements','comparisons'],1):
 body=next(b for b in blocks if key in b)
 envelope={'schema_version':'0.4','project_id':'example','source_revision':'example-snapshot','run_id':'example-run','stage':i,'status':'completed','data':body}
 (root/'contracts'/'examples'/f'stage-{i}.json').write_text(json.dumps(envelope,ensure_ascii=False,indent=2)+'\n')
