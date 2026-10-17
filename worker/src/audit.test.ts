import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSource} from './java-index.ts';
import {extractApis} from './spring.ts';
import {navigate,type BackendIndex} from './authz-index.ts';
import {buildAudit,auditCoverage,hardenSubmission} from './authz-audit.ts';
import {finalizeSubmission,type AuthSubmission} from './stage2.ts';
function fixture(source:string){const file='src/main/java/p/C.java',classes=parseSource(source,file);const index:BackendIndex={classes,sources:new Map([[file,source]]),files:[],diagnostics:[],sql:[],artifactDiagnostics:[],resolve(type,owner){return classes.find(c=>c.fqn===type||c.fqn===owner.pkg+'.'+type);}};const entry=extractApis(index,'rev')[0];const nav=navigate(index,entry);return {index,entry,nav,file,e:{file,start_line:1,end_line:source.split('\n').length}};}
const simple='package p; @RestController class C{@PostMapping("/x") void run(@RequestParam String id){save(id);} void save(String id){}}';
function proposal(e:any):AuthSubmission{return {operations:[{ref:'one',action:'update',resource:'records',anchor:e,description:'Update records by id',evidence:[e]}],checks:[],scope:[],unresolved:[]};}
test('config-dependent authentication without applicability is withheld, not silently accepted',()=>{
 const f=fixture(simple),a=buildAudit(f.index,f.nav,f.entry);a.conditions=[{id:'external_anonymous_routes',description:'excludeUrls',evidence:[f.e]}];
 const p=proposal(f.e);p.checks=[{kind:'authentication',fields:[],rule:'JWT authentication',execution:'enforced',effect_evidence:[f.e],evidence:[f.e]}];
 const missing=hardenSubmission(p,f.entry,f.nav,f.index,[f.e],a);assert.equal(missing.proposal.checks.length,0);assert.ok(missing.proposal.unresolved.some(s=>s.includes('配置依赖')));
 p.checks[0].conditions=['Only if excludeUrls does not match'];assert.equal(hardenSubmission(p,f.entry,f.nav,f.index,[f.e],a).proposal.checks.length,1);
});
test('reading an arbitrary line does not satisfy a mechanism method range',()=>{
 const f=fixture(simple),a=buildAudit(f.index,f.nav,f.entry);a.mechanisms=[{id:'m1',label:'guard and deny branch',role:'authentication',evidence:[{file:f.file,start_line:2,end_line:8}]}];
 assert.equal(auditCoverage(a,[f.e],f.nav).mechanisms[0].read_complete,false);
 assert.ok(auditCoverage(a,[{file:f.file,start_line:2,end_line:8}],f.nav).mechanisms[0].read_complete);
});
test('opaque custom calls cannot disappear or become irrelevant without complete call-site evidence',()=>{
 const f=fixture('package p; @RestController class C{ Remote auth; @PostMapping("/x") void run(@RequestParam String id){auth.allow(id); save(id);} void save(String id){}}'),a=buildAudit(f.index,f.nav,f.entry),g=a.groups.find(g=>g.disposition==='unresolved')!;
 assert.ok(g);assert.ok(auditCoverage(a,[],f.nav).issues.some(s=>s.includes(g.id)));
 const invalid={id:g.id,disposition:'irrelevant' as const,reason:'not used by operation',evidence:[]};assert.ok(auditCoverage(a,[f.e],f.nav,[invalid]).issues.some(s=>s.includes(g.id)));
 assert.ok(!auditCoverage(a,[f.e],f.nav,[{...invalid,evidence:[f.e]}]).issues.some(s=>s.includes(g.id)));
});
test('duplicate effect anchors merge and check references retain the same business operation',()=>{
 const f=fixture(simple),p=proposal(f.e);p.operations.push({...p.operations[0],ref:'two',description:'Same write, another description'});
 p.checks=[{kind:'resource_relation',fields:['query:id'],rule:'Enforced actor relationship',operation_refs:['two'],execution:'enforced',effect_evidence:[f.e],evidence:[f.e]}];
 const h=hardenSubmission(p,f.entry,f.nav,f.index,[f.e],buildAudit(f.index,f.nav,f.entry));assert.equal(h.proposal.operations.length,1);assert.deepEqual(h.proposal.checks[0].operation_refs,['one']);
 const d=finalizeSubmission(h.proposal,f.entry,f.nav,f.index,[f.e]);assert.ok(d.operation);assert.equal(d.checks.length,1);
});
test('supporting operations are retained outside core and partial protection requires operation refs',()=>{
 const f=fixture(simple),p=proposal(f.e);p.operations.push({...p.operations[0],ref:'lookup',role:'supporting',description:'Prerequisite lookup'});
 const h=hardenSubmission(p,f.entry,f.nav,f.index,[f.e],buildAudit(f.index,f.nav,f.entry));assert.equal(h.proposal.operations.length,1);assert.equal(h.audit.supporting_operations.length,1);
 p.operations[1]={...p.operations[1],role:'primary',resource:'another_resource'};
 p.checks=[{kind:'resource_relation',fields:[],rule:'First operation only',execution:'enforced',effect_evidence:[f.e],evidence:[f.e]}];
 assert.throws(()=>hardenSubmission(p,f.entry,f.nav,f.index,[f.e],buildAudit(f.index,f.nav,f.entry)),/operation_refs_required/);
});
test('nonblocking, uncertain and unsupported effects cannot become effective checks',()=>{
 const f=fixture(simple),p=proposal(f.e),a=buildAudit(f.index,f.nav,f.entry);
 p.checks=[{kind:'resource_relation',fields:[],rule:'Guard after write or caught rejection',execution:'not_blocking',evidence:[f.e]}];assert.equal(hardenSubmission(p,f.entry,f.nav,f.index,[f.e],a).proposal.checks.length,0);
 p.checks[0].execution='unresolved';assert.ok(hardenSubmission(p,f.entry,f.nav,f.index,[f.e],a).proposal.unresolved.length);
 p.checks[0].execution='enforced';assert.throws(()=>hardenSubmission(p,f.entry,f.nav,f.index,[f.e],a),/effect_evidence_required/);
});
test('unknown triage is evidence backed and never erases mandatory unresolved calls',()=>{
 const f=fixture('package p; @RestController class C{Remote auth;@PostMapping("/x")void run(@RequestParam String id){auth.allow(id);save(id);}void save(String id){}}'),a=buildAudit(f.index,f.nav,f.entry),p=proposal(f.e);
 p.unresolved=['specific user grant not available'];p.unresolved_reviews=[{issue:p.unresolved[0],disposition:'deferred',reason:'predicate extraction does not require a specific user grant',evidence:[f.e]}];
 const h=hardenSubmission(p,f.entry,f.nav,f.index,[f.e],a);assert.ok(!h.proposal.unresolved.includes(p.unresolved[0]));assert.ok(h.proposal.unresolved.some(s=>s.includes('调用组')));assert.equal(h.audit.unknown_reviews.length,1);
 p.unresolved_reviews[0].evidence=[];assert.throws(()=>hardenSubmission(p,f.entry,f.nav,f.index,[f.e],a),/review_not_evidenced/);
});

test('a source-backed deferred note need not be duplicated in blocking unresolved',()=>{
 const f=fixture(simple),p=proposal(f.e);p.unresolved_reviews=[{issue:'specific grant value',disposition:'deferred',reason:'not needed to extract predicate',evidence:[f.e]}];
 const h=hardenSubmission(p,f.entry,f.nav,f.index,[f.e],buildAudit(f.index,f.nav,f.entry));assert.equal(h.audit.unknown_reviews.length,1);assert.ok(!h.proposal.unresolved.includes('specific grant value'));
});

test('typed Principal String chain and standard exception construction do not become opaque custom authorization',()=>{
 const source='package p; import java.security.Principal; @RestController class C{ @PostMapping("/x") void run(@RequestParam String id, Principal principal){if(!principal.getName().equals(id))throw new SecurityException();save(id);}void save(String id){}}';
 const f=fixture(source),a=buildAudit(f.index,f.nav,f.entry);assert.ok(!a.groups.some(g=>g.disposition==='unresolved'));
 const custom=fixture(source.replace('import java.security.Principal;','').replace('Principal principal','Remote principal'));assert.ok(buildAudit(custom.index,custom.nav,custom.entry).groups.some(g=>g.disposition==='unresolved'&&g.calls.some(c=>c.call===").equals")));
});


test('write pipelines include source-defined MyBatis mutation interception in required scope',()=>{
 const f=fixture(simple+' class MybatisInterceptor { Object intercept(Object invocation){ return invocation; } }'),a=buildAudit(f.index,f.nav,f.entry);assert.ok(a.mechanisms.some(m=>m.role==='mutation_pipeline'&&m.label==='MybatisInterceptor.intercept'));
});
