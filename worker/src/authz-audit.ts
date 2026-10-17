/** Internal evidence obligations. Not a public schema or an authorization policy oracle. */
import {createHash} from 'node:crypto';
import {calls,constant,type ApiEntry} from './spring.ts';
import {tokens,ev,type Evidence} from './java-index.ts';
import type {BackendIndex,Navigation,Edge} from './authz-index.ts';
import type {AuthSubmission,AuthOperation} from './stage2.ts';
import {sourceFacts,contains,type SourceFacts} from './authz-facts.ts';
export const auditId=(prefix:string,v:unknown)=>prefix+'-'+createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
export function covers(e:Evidence,reads:Evidence[]){let p=e.start_line;for(const r of reads.filter(r=>r.file===e.file).sort((a,b)=>a.start_line-b.start_line)){if(r.start_line>p)break;if(r.end_line>=p)p=r.end_line+1;if(p>e.end_line)return true;}return false;}
export type Obligation={id:string;label:string;role:string;evidence:Evidence[]};
export type CallGroup={id:string;symbol:string;file:string;calls:{id:string;call:string;line:number;owner_type:string}[];disposition:string;reason:string};
export type ScopeReview={id:string;disposition:'framework_boundary'|'irrelevant'|'unresolved';reason:string;evidence:Evidence[]};
export type AuditContext={mechanisms:Obligation[];groups:CallGroup[];conditions:{id:string;description:string;evidence:Evidence[]}[];diagnostics:string[];facts:SourceFacts};
function matches(pattern:string,route:string){const exp='^'+pattern.split('**').map(s=>s.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')).join('.*')+'$';return new RegExp(exp).test(route);}
function importedType(index:BackendIndex,edge:Edge){return (edge.owner_type||'').replace(/<.*>/g,'');}
export function buildAudit(index:BackendIndex,nav:Navigation,input:ApiEntry):AuditContext{
 const a:AuditContext={mechanisms:[],groups:[],conditions:[],diagnostics:[],facts:sourceFacts(index,nav)};
 const add=(role:string,label:string,evidence:Evidence[])=>{if(evidence.length)a.mechanisms.push({id:auditId('mechanism',[role,evidence]),label,role,evidence});};
 const method=(cls:string,name:string,role:string)=>{for(const c of index.classes.filter(c=>c.name===cls)){const m=c.methods.find(m=>m.name===name);if(m)add(role,cls+'.'+name,[{file:c.file,start_line:Math.max(1,m.line-1),end_line:m.end}]);}};
 for(const c of index.classes.filter(c=>c.name==='ShiroConfig')){
  const m=c.methods.find(m=>['shiroFilter','shiroFilterFactoryBean'].includes(m.name));if(!m)continue;
  const ev:Evidence[]=[{file:c.file,start_line:m.line,end_line:Math.min(m.end,m.line+24)}];
  for(const x of calls(m.body))if(x.name==='put'&&x.args.length===2){const p=constant(x.args[0],c,index);if(p&&matches(p,input.api.path))ev.push({file:c.file,start_line:x.line,end_line:x.line});}
  add('route','route setup, matching declarations and external exclusions',ev);
  if(index.sources.get(c.file)?.includes('getExcludeUrls'))a.conditions.push({id:'external_anonymous_routes',description:'JWT applies only if no earlier anonymous route, including externally configured excludeUrls, matches this API; deployment overrides are not provided.',evidence:[ev[0]]});
 }
 method('JwtFilter','executeLogin','authentication');method('JwtFilter','onAccessDenied','authentication');method('ShiroRealm','checkUserTokenIsEffect','authentication');
 if(nav.candidates.some(c=>c.kind==='annotation'&&/Requires|PreAuthorize/.test(c.description)))method('ShiroConfig','authorizationAttributeSourceAdvisor','permission_advisor');
 if(nav.candidates.some(c=>['operation','sql'].includes(c.kind))){for(const c of index.classes.filter(c=>c.name==='MybatisPlusSaasConfig')){
  const f=c.fields.find(f=>f.name==='OPEN_SYSTEM_TENANT_CONTROL');if(f){const ts=tokens(f.node);add('tenant','tenant flag and table registration',[{file:c.file,start_line:ts[0].startLine,end_line:Math.min(ts[0].startLine+38,index.sources.get(c.file)!.split('\n').length)}]);}
  // ignoreTable is an anonymous-class method and may not be in the ordinary symbol index.
  const lines=index.sources.get(c.file)!.split('\n'),at=lines.findIndex(l=>l.includes('boolean ignoreTable('));if(at>=0)add('tenant','tenant table applicability',[{file:c.file,start_line:at+1,end_line:Math.min(at+11,lines.length)}]);
 }}
 if(nav.candidates.some(c=>c.kind==='operation'&&/\.(save|insert|update|delete|remove)/i.test(c.description))){method('MybatisInterceptor','intercept','mutation_pipeline');method('MybatisInterceptor','getLoginUser','mutation_pipeline');}
 if(nav.candidates.some(c=>c.description.includes('@PermissionData'))){method('PermissionDataAspect','arround','data_policy');method('QueryGenerator','getRuleMap','data_policy');method('QueryGenerator','installMplus','data_policy');}
 // A Mapper annotation can be on a declaration without a body, so it is not necessarily
 // visited as a call-graph node. Link it through the exact namespace and statement ID.
 for(const s of nav.candidates.filter(c=>c.kind==='sql'))for(const c of index.classes){
  for(const m of c.methods.filter(m=>s.description.endsWith(c.fqn+'.'+m.name))){
   for(const ann of [...c.annotations,...m.annotations].filter(a=>a.name==='InterceptorIgnore'))add('tenant_override','Mapper override '+c.fqn+'.'+m.name,[ev(c,ann.node)]);
  }
 }
 for(const e of nav.edges){
  const n=nav.nodes.find(n=>n.symbol===e.from);if(!n)continue;
  const owner=importedType(index,e),sourceLine=(index.sources.get(n.file)||'').split('\n')[e.line-1]||'';
  let disposition='unresolved',reason='implementation/effect not resolved; requires source-backed review';
  if(['resolved','sql'].includes(e.status)){disposition='resolved_source';reason='linked implementation or SQL; enforcement is not implied';}
  else if(e.status==='framework_crud'){disposition='framework_boundary';reason='indexed CRUD invocation; actual predicates and interceptor applicability still require evidence';}
  else if(/^(java\.|javax\.|jakarta\.|org\.apache\.commons\.|org\.slf4j\.|com\.baomidou\.|com\.alibaba\.fastjson|cn\.hutool\.)/.test(owner)||['String','Integer','Long','Boolean','Math','Arrays','Collections','Collectors','Objects','UUID','Date','List','Map','Set','HashMap','ArrayList','SecurityException','RuntimeException','IllegalArgumentException','IllegalStateException','log','logger'].includes(owner)){
   disposition='framework_boundary';reason='declared standard/library receiver '+owner+'; value/query construction is not an authorization conclusion';
  }else if(e.status==='framework_value_boundary'){disposition='framework_boundary';reason='explicitly bounded framework value helper; no authorization protection inferred';}
  else if(/\bnew\s+\w+\s*\(/.test(sourceLine)&&!e.call.includes('.')&&index.classes.some(c=>c.name===e.call&&c.annotations.some(a=>['Data','TableName'].includes(a.name)))){disposition='framework_boundary';reason='declared data-object construction; no protection inferred';}
  const key=[e.from,disposition],id=auditId('calls',key);let g=a.groups.find(g=>g.id===id);
  if(!g){g={id,symbol:e.from,file:n.file,calls:[],disposition,reason};a.groups.push(g);}
  g.calls.push({id:auditId('call',[e.from,e.line,e.call,e.arguments]),call:e.call,line:e.line,owner_type:owner});
 }
 a.diagnostics=[...index.diagnostics,...index.artifactDiagnostics.filter(d=>!d.includes('code_template_not_runtime_mapper'))];return a;
}
export function auditCoverage(a:AuditContext,reads:Evidence[],nav:Navigation,reviews:ScopeReview[]=[]){
 const issues:string[]=[],groups=a.groups.map(g=>({...g,review:null as ScopeReview|null}));
 for(const g of groups){if(g.disposition!=='unresolved')continue;const r=reviews.find(r=>r.id===g.id);
  if(r&&r.reason.trim()&&r.evidence.length&&r.evidence.every(e=>covers(e,reads))&&g.calls.every(c=>covers({file:g.file,start_line:c.line,end_line:c.line},r.evidence))){g.review=r;g.disposition=r.disposition;g.reason=r.reason;}
  if(g.disposition==='unresolved')issues.push('调用组未核实：'+g.id+' '+g.symbol+'（'+g.calls.length+' 个调用）');
 }
 const mechanisms=a.mechanisms.map(m=>({...m,read_complete:m.evidence.every(e=>covers(e,[...reads,...nav.disabled]))}));
 for(const m of mechanisms)if(!m.read_complete)issues.push('关键机制未完整阅读：'+m.id+' '+m.label);
 for(const d of a.diagnostics)issues.push('源码索引诊断待核实：'+d);
 return {groups,mechanisms,issues};
}
export type AuditReview=ScopeReview;
export function hardenSubmission(proposal:AuthSubmission,input:ApiEntry,nav:Navigation,index:BackendIndex,reads:Evidence[],a:AuditContext){
 const p=structuredClone(proposal),supporting:any[]=[],rejected:any[]=[],conditionIssues:string[]=[],map=new Map<string,string>(),seen=new Map<string,AuthOperation>();
 const allRefs=new Set<string>();
 const operations:AuthOperation[]=[];
 for(const op of p.operations){
  if(!op.ref||allRefs.has(op.ref))throw new Error('duplicate_operation_reference');allRefs.add(op.ref);
  if(op.role==='supporting'){
   if(!op.evidence.length||!op.evidence.every(e=>covers(e,reads)))throw new Error('supporting_evidence_not_read');
   const mutations=a.facts.mutations.filter(f=>op.evidence.some(e=>contains(e,f.evidence)));
   // Reflection field.set is conditional on all enclosing source branches, including
   // INSERT/UPDATE and emptiness guards. Preserve the original claim for audit only.
   supporting.push(mutations.length?{...op,original_description:op.description,description:'持久化字段赋值：以 guarded_mutations 中每个调用及其全部源码条件为准；不能概括为无条件覆盖。',guarded_mutations:mutations}:op);continue;
  }
  const anchor=op.anchor||op.evidence.find(e=>nav.candidates.some(c=>['operation','sql'].includes(c.kind)&&c.evidence.file===e.file&&c.evidence.start_line>=e.start_line&&c.evidence.end_line<=e.end_line))||op.evidence[0];
  if(!anchor||!covers(anchor,reads)||!op.evidence.some(e=>e.file===anchor.file&&e.start_line<=anchor.start_line&&e.end_line>=anchor.end_line))throw new Error('operation_anchor_not_read');
  const effects=a.facts.effects.filter(f=>contains(anchor,f.evidence));
  if(new Set(effects.map(f=>f.resource+':'+f.action)).size>1)throw new Error('split_distinct_resource_effects: '+JSON.stringify(effects));
  const canonical=[op.resource||'',op.action||'',anchor.file,anchor.start_line,anchor.end_line];const k=JSON.stringify(canonical);
  const existing=seen.get(k);if(existing){map.set(op.ref,existing.ref);existing.evidence=[...existing.evidence,...op.evidence].filter((e,i,arr)=>arr.findIndex(x=>JSON.stringify(x)===JSON.stringify(e))===i);continue;}
  op.anchor=anchor;op.canonical_key=canonical;seen.set(k,op);map.set(op.ref,op.ref);operations.push(op);
 }
 if(!operations.length)throw new Error('primary_business_operation_required');p.operations=operations;
 const coverage=auditCoverage(a,reads,nav,p.call_reviews||[]);
 const checks:typeof p.checks=[];
 for(const c of p.checks){
  c.operation_refs=c.operation_refs?.map(r=>map.get(r)||r);
  const core=!['validation','request_filter','observation'].includes(c.kind||'')&&!(c.kind==='query_scope'&&['request_only','unknown'].includes(c.scope_source||''));
  if(core&&operations.length>1&&(!c.operation_refs?.length||c.operation_refs.some(r=>!map.has(r)&&!operations.some(o=>o.ref===r))))throw new Error('explicit_operation_refs_required');
  if(core&&c.operation_refs?.some(r=>!operations.some(o=>o.ref===r)))throw new Error('unknown_or_supporting_operation_reference');
  const jwt=c.kind==='authentication'&&(/jwt/i.test(c.rule)||c.evidence.some(e=>/\/(JwtFilter|ShiroRealm)\.java$/.test(e.file)));
  const relevant=a.mechanisms.filter(m=>jwt?['route','authentication'].includes(m.role):c.kind==='action_permission'?m.role==='permission_advisor':c.kind==='query_scope'&&c.scope_source==='database_policy'?m.role==='data_policy':false);
  const unread=relevant.filter(m=>!coverage.mechanisms.find(x=>x.id===m.id)?.read_complete);
  const configMissing=core&&jwt&&a.conditions.length&&!c.conditions?.some(s=>/excludeUrls|匿名|anon/i.test(s));
  if(core&&(unread.length||configMissing)){
   const reason=configMissing?'配置依赖 external_anonymous_routes 未表达适用条件':'关键机制未完整核查：'+unread.map(m=>m.id).join(',');rejected.push({...c,reason});conditionIssues.push('检查候选未确认：'+reason);continue;
  }
  if(core&&jwt){
   const claims=[...c.conditions||[],c.rule].join(' '),patterns=claims.match(/\/[A-Za-z0-9_{}./*-]*\*[A-Za-z0-9_{}./*-]*/g)||[];
   if(patterns.some(pattern=>!a.facts.routes.some(r=>r.pattern===pattern))){rejected.push({...c,reason:'路由通配条件没有源码声明依据'});conditionIssues.push('检查候选路由条件未确认：存在未声明的通配模式');continue;}
  }
  if(core&&c.execution==='unresolved'){rejected.push({...c,reason:'执行效果未明确'});conditionIssues.push('检查候选执行效果未明确：'+c.rule);continue;}
  if(core&&c.execution==='not_blocking'){rejected.push({...c,reason:'检查未阻止对应操作'});continue;}
  if(core&&c.execution==='enforced'){
   if(!c.effect_evidence?.length||!c.effect_evidence.every(e=>covers(e,reads)))throw new Error('enforcement_effect_evidence_required');
   if(c.effect_evidence.some(e=>nav.disabled.some(d=>d.file===e.file&&d.start_line<=e.start_line&&d.end_line>=e.end_line))){rejected.push({...c,reason:'执行效果证据位于已知关闭分支'});continue;}
   if(c.kind==='resource_relation'){
    const proof=[...c.evidence,...c.effect_evidence];
    const guards=a.facts.guards.filter(g=>proof.some(e=>contains(e,g.condition_evidence))&&g.rejections.some(r=>c.effect_evidence!.some(e=>contains(e,r))));
    if(!guards.length)throw new Error('relation_guard_and_rejection_evidence_required: cite the actual comparison and return/throw, not only a query or write; SQL-only scope uses query_scope with trusted bindings');
    const affected=operations.filter(o=>!c.operation_refs?.length||c.operation_refs.includes(o.ref));
    if(guards.every(g=>affected.some(o=>o.anchor!.file===g.condition_evidence.file&&o.anchor!.end_line<g.condition_evidence.start_line)))throw new Error('guard_after_protected_operation');
    if(guards.every(g=>g.catch_evidence.length)){rejected.push({...c,reason:'拒绝语句位于存在 catch 的 try 中，尚未证明异常传播阻止目标操作',catch_evidence:guards.flatMap(g=>g.catch_evidence)});conditionIssues.push('检查候选异常传播效果未确认：'+c.rule);continue;}
   }
   c.evidence=[...c.evidence,...c.effect_evidence].filter((e,i,arr)=>arr.findIndex(x=>JSON.stringify(x)===JSON.stringify(e))===i);
  }
  checks.push(c);
 }
 p.checks=checks;
 const effectCoverage=a.facts.effects.map(f=>({...f,operation_refs:operations.filter(o=>contains(o.anchor!,f.evidence)).map(o=>o.ref),supporting_refs:supporting.filter(o=>o.evidence.some((e:Evidence)=>contains(e,f.evidence))).map(o=>o.ref)}));
 for(const f of effectCoverage)if(covers(f.evidence,reads)&&!f.operation_refs.length&&!f.supporting_refs.length)conditionIssues.push('已读资源效果尚未关联独立业务操作或有依据的辅助操作：'+f.id+' '+f.resource+' '+f.action);
 const mechanismReviews:NonNullable<AuthSubmission['mechanism_reviews']>=[],rejectedReviews:any[]=[];
 for(const review of p.mechanism_reviews||[]){const m=a.mechanisms.find(m=>m.id===review.id);if(!m||!review.reason.trim()||!review.evidence.length||!review.evidence.every(e=>covers(e,reads))||!m.evidence.every(e=>covers(e,review.evidence))){rejectedReviews.push({...review,reason:'可选机制说明未采纳：标识、完整机制范围或已读证据不匹配',original_reason:review.reason});continue;}mechanismReviews.push(review);}
 for(const m of a.mechanisms.filter(m=>m.role==='tenant_override'))if(!mechanismReviews.some(r=>r.id===m.id))conditionIssues.push('Mapper 拦截忽略设置尚未解释：'+m.id+' '+m.label);
 const triage:any[]=[];
 for(const r of p.unresolved_reviews||[]){
  if(!r.reason.trim()||!r.evidence.length||!r.evidence.every(e=>covers(e,reads))){rejectedReviews.push({...r,reason:'可选未知分层未采纳：证据不完整，不能据此删除未知',original_reason:r.reason});continue;}
  triage.push(r);if(r.disposition!=='blocking')p.unresolved=p.unresolved.filter(x=>x!==r.issue);
 }
 p.unresolved=[...new Set([...p.unresolved,...coverage.issues,...conditionIssues])];
 return {proposal:p,audit:{call_groups:coverage.groups,mechanisms:coverage.mechanisms,mechanism_reviews:mechanismReviews,rejected_reviews:rejectedReviews,source_facts:a.facts,effect_coverage:effectCoverage,condition_dependencies:a.conditions,supporting_operations:supporting,operation_anchors:operations.map(o=>({ref:o.ref,anchor:o.anchor,resource:o.resource,action:o.action})),confirmed_checks:checks.filter(c=>!['validation','request_filter','observation'].includes(c.kind||'')&&!(c.kind==='query_scope'&&['request_only','unknown'].includes(c.scope_source||''))),unconfirmed_checks:rejected,unknown_reviews:triage,mandatory_unresolved:[...coverage.issues,...conditionIssues]}};
}
