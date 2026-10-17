import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSource,type Evidence} from './java-index.ts';
import {extractApis} from './spring.ts';
import {navigate,type BackendIndex} from './authz-index.ts';
import {buildAudit,hardenSubmission} from './authz-audit.ts';
import {requestReservation,estimateContextTokens} from './authz-budget.ts';
import {finalizeSubmission,type AuthSubmission} from './stage2.ts';
function fixture(source:string){
 const file='src/main/java/sample/Controller.java',classes=parseSource(source,file);
 const index:BackendIndex={classes,sources:new Map([[file,source]]),files:[],diagnostics:[],sql:[],artifactDiagnostics:[],resolve(type,owner){return classes.find(c=>c.fqn===type||c.fqn===owner.pkg+'.'+type);}};
 const entry=extractApis(index,'fixed')[0],nav=navigate(index,entry),audit=buildAudit(index,nav,entry);
 const e=(start:number,end=start):Evidence=>({file,start_line:start,end_line:end});
 return {index,entry,nav,audit,e,reads:[e(1,source.split('\n').length)]};
}
const guarded=`package sample;
@RestController class Controller {
 RecordsService records;
 @PostMapping("/record") void edit(@RequestParam String id) {
  if(!id.equals("allowed")) throw new SecurityException();
  records.updateById(id);
 }
}
class RecordsService extends ServiceImpl<Mapper,Record> {}
@TableName("records") class Record {}
`;
function proposal(f:ReturnType<typeof fixture>):AuthSubmission{return {operations:[{ref:'write',resource:'records',action:'update',anchor:f.e(6),description:'Update the requested record',evidence:[f.e(6)]}],checks:[{kind:'resource_relation',fields:['query:id'],rule:'The comparison must permit the requested record update',execution:'enforced',operation_refs:['write'],evidence:[f.e(5)],effect_evidence:[f.e(5)]}],scope:[],unresolved:[]};}
function harden(f:ReturnType<typeof fixture>,p:AuthSubmission){return hardenSubmission(p,f.entry,f.nav,f.index,f.reads,f.audit);}
test('a later write and owner SELECT cannot substitute for the comparison and throw proof',()=>{
 const f=fixture(guarded),p=proposal(f);p.checks[0].evidence=[f.e(6)];p.checks[0].effect_evidence=[f.e(6)];
 assert.throws(()=>harden(f,p),/guard_and_rejection/);
 const valid=harden(f,proposal(f));assert.equal(valid.proposal.checks.length,1);
 const data=finalizeSubmission(valid.proposal,f.entry,f.nav,f.index,f.reads);assert.ok(data.checks[0].evidence.some((e:Evidence)=>e.start_line===5));
});
test('post-write guards and caught rejection cannot be submitted as confirmed resource protection',()=>{
 const late=fixture(guarded.replace('  if(!id.equals("allowed")) throw new SecurityException();\n  records.updateById(id);','  records.updateById(id);\n  if(!id.equals("allowed")) throw new SecurityException();'));
 const p=proposal(late);p.operations[0].anchor=late.e(5);p.operations[0].evidence=[late.e(5)];p.checks[0].evidence=[late.e(6)];p.checks[0].effect_evidence=[late.e(6)];assert.throws(()=>harden(late,p),/guard_after_protected/);
 const caught=fixture(guarded.replace('if(!id.equals("allowed")) throw new SecurityException();','try{if(!id.equals("allowed")) throw new SecurityException();}catch(SecurityException ignored){}'));
 const h=harden(caught,proposal(caught));assert.equal(h.proposal.checks.length,0);assert.ok(h.proposal.unresolved.some(x=>x.includes('异常传播')));
});
test('a rejecting return inside try is not intercepted by a catch clause',()=>{
 const f=fixture(guarded.replace('if(!id.equals("allowed")) throw new SecurityException();','try{if(!id.equals("allowed")) return;}catch(SecurityException ignored){}'));
 assert.equal(harden(f,proposal(f)).proposal.checks.length,1);
});
test('different write resources must have separate anchors and explicitly scoped checks',()=>{
 const f=fixture(guarded.replace(' RecordsService records;',' RecordsService records; LinksService links;').replace('  records.updateById(id);','  records.updateById(id);\n  links.removeById(id);').replace('@TableName("records") class Record {}','@TableName("records") class Record {}\nclass LinksService extends ServiceImpl<LinkMapper,Link> {}\n@TableName("links") class Link {}'));
 assert.deepEqual(f.audit.facts.effects.map(e=>[e.resource,e.action]),[['records','update'],['links','delete']]);
 const merged=proposal(f);merged.operations[0].anchor=f.e(6,7);merged.operations[0].evidence=[f.e(6,7)];assert.throws(()=>harden(f,merged),/split_distinct_resource_effects/);
 const separate=proposal(f);separate.operations.push({ref:'unlink',resource:'links',action:'delete',anchor:f.e(7),description:'Delete link',evidence:[f.e(7)]});
 const missing=structuredClone(separate);delete missing.checks[0].operation_refs;assert.throws(()=>harden(f,missing),/operation_refs_required/);
 const h=harden(f,separate);assert.equal(h.audit.effect_coverage.filter(e=>!e.operation_refs.length).length,0);
 const out=finalizeSubmission(h.proposal,f.entry,f.nav,f.index,f.reads);assert.equal(out.operations?.length,2);assert.equal(out.checks[0].operation_ids.length,1);
 const omitted=harden(f,proposal(f));assert.ok(omitted.proposal.unresolved.some(x=>x.includes('独立业务操作')));
});
test('unknown, duplicate and supporting-only operation refs are never silently discarded',()=>{
 const f=fixture(guarded),p=proposal(f);p.checks[0].operation_refs=['made-up'];assert.throws(()=>harden(f,p),/operation_reference/);
 p.operations.push({...p.operations[0],ref:'lookup',role:'supporting'});p.checks[0].operation_refs=['lookup'];assert.throws(()=>harden(f,p),/supporting_operation_reference/);
 p.operations[1].ref='write';assert.throws(()=>harden(f,p),/duplicate_operation_reference/);
});
test('authentication conditions cannot invent anonymous wildcard declarations',()=>{
 const f=fixture(guarded+`class ShiroConfig { void shiroFilter(){map.put("/public/**","anon");map.put("/**","jwt");} }`),p=proposal(f);
 p.checks=[{kind:'authentication',rule:'JWT authentication',fields:[],execution:'enforced',operation_refs:['write'],evidence:[f.e(5)],effect_evidence:[f.e(5)],conditions:['只有 /sys/** anon 不匹配时']}];
 assert.ok(f.audit.facts.routes.some(r=>r.pattern==='/public/**'));
 const invalid=harden(f,p);assert.equal(invalid.proposal.checks.length,0);assert.ok(invalid.proposal.unresolved.some(x=>x.includes('通配模式')));
 p.checks[0].conditions=['只有 external excludeUrls 不匹配且匹配 /** 的 jwt 时'];assert.equal(harden(f,p).proposal.checks.length,1);
});
test('Mapper InterceptorIgnore declarations without bodies are obligatory and must be explained',()=>{
 const source=`package sample;
@RestController class Controller {
 Mapper mapper;
 @GetMapping("/record") Object rows(){return mapper.rows();}
}
interface Mapper {
 @InterceptorIgnore(tenantLine="true")
 @Select("select * from records") Object rows();
}`;
 const f=fixture(source);f.index.sql=[{namespace:'sample.Mapper',id:'rows',kind:'select',evidence:f.e(8),includes:[],dynamic:[]}];f.nav=navigate(f.index,f.entry);f.audit=buildAudit(f.index,f.nav,f.entry);
 const m=f.audit.mechanisms.find(m=>m.role==='tenant_override')!;assert.ok(m);
 const p:AuthSubmission={operations:[{ref:'query',description:'Read records',resource:'records',action:'read',anchor:f.e(8),evidence:[f.e(8)]}],checks:[],scope:[],unresolved:[]};
 assert.ok(harden(f,p).proposal.unresolved.some(s=>s.includes(m.id)));
 p.mechanism_reviews=[{id:m.id,reason:'Exact rows statement has tenantLine=true; do not infer tenant isolation for this query',evidence:[f.e(7)]}];assert.ok(!harden(f,p).proposal.unresolved.some(s=>s.includes(m.id)));
 p.mechanism_reviews[0].evidence=[f.e(8)];const invalid=harden(f,p);assert.ok(invalid.proposal.unresolved.some(s=>s.includes(m.id)));assert.equal(invalid.audit.rejected_reviews.length,1);
});
test('reflection assignments preserve INSERT versus UPDATE and all enclosing empty-value conditions',()=>{
 const f=fixture(guarded+`class MybatisInterceptor {
 void intercept(Object parameter){
  if(command.equals("INSERT")) {
   if(field.getName().equals("created")) {
    Object old=field.get(parameter);
    if(old==null) field.set(parameter, now);
   }
  }
  if(command.equals("UPDATE")){field.set(parameter, now);}
 }
}`);
 const writes=f.audit.facts.mutations;assert.equal(writes.length,2);assert.equal(writes[0].guards.length,3);assert.equal(writes[1].guards.length,1);assert.ok(writes[0].guards.some(g=>g.condition.includes('old == null')));
 const p=proposal(f);p.operations.push({ref:'audit',role:'supporting',description:'Always forcibly overwrites timestamp on insert and update',evidence:[f.e(12,20)]});
 const support=harden(f,p).audit.supporting_operations[0];assert.ok(support.original_description.includes('forcibly'));assert.ok(!support.description.includes('forcibly'));assert.equal(support.guarded_mutations.length,2);
});
test('request reservation includes repeated prompt cost, cached input, growth and final output allowance',()=>{
 assert.equal(requestReservation(42000,60000,15000,1000,500,4096).allowed,false);
 assert.equal(requestReservation(20000,60000,9000,1000,0,4096).allowed,true);
 assert.equal(requestReservation(60000,60000,1,1,0,4096).allowed,false);
 assert.equal(requestReservation(20000,60000,9000,1000,-20000,4096).estimated_next_request,14096);
});
test('large Java source growth is estimated as tokens rather than charged as UTF-8 bytes',()=>{
 const code='String username = principal.getName();\n'.repeat(1000),estimate=estimateContextTokens({content:code});
 assert.ok(estimate<Buffer.byteLength(code)*.6);assert.ok(estimate>5000);
 assert.ok(requestReservation(10000,60000,9000,1000,Math.ceil(estimate*1.25),4096).allowed);
 assert.ok(estimateContextTokens({content:'当前请求者'.repeat(1000)})>5000);
});
