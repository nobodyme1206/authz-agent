/** Internal evidence obligations. Not a public schema or an authorization policy oracle. */
import {createHash} from 'node:crypto';
import {calls,constant,type ApiEntry} from './spring.ts';
import {tokens,type Evidence} from './java-index.ts';
import type {BackendIndex,Navigation,Edge} from './authz-index.ts';
import type {AuthSubmission,AuthOperation} from './stage2.ts';
export const auditId=(prefix:string,v:unknown)=>prefix+'-'+createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
export function covers(e:Evidence,reads:Evidence[]){let p=e.start_line;for(const r of reads.filter(r=>r.file===e.file).sort((a,b)=>a.start_line-b.start_line)){if(r.start_line>p)break;if(r.end_line>=p)p=r.end_line+1;if(p>e.end_line)return true;}return false;}
export type Obligation={id:string;label:string;role:string;evidence:Evidence[]};
export type CallGroup={id:string;symbol:string;file:string;calls:{id:string;call:string;line:number;owner_type:string}[];disposition:string;reason:string};
export type ScopeReview={id:string;disposition:'framework_boundary'|'irrelevant'|'unresolved';reason:string;evidence:Evidence[]};
export type AuditContext={mechanisms:Obligation[];groups:CallGroup[];conditions:{id:string;description:string;evidence:Evidence[]}[];diagnostics:string[]};
function matches(pattern:string,route:string){const exp='^'+pattern.split('**').map(s=>s.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')).join('.*')+'$';return new RegExp(exp).test(route);}
function importedType(index:BackendIndex,edge:Edge){return (edge.owner_type||'').replace(/<.*>/g,'');}
export function buildAudit(index:BackendIndex,nav:Navigation,input:ApiEntry):AuditContext{
 const a:AuditContext={mechanisms:[],groups:[],conditions:[],diagnostics:[]};
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
 if(nav.candidates.some(c=>c.description.includes('@PermissionData'))){method('PermissionDataAspect','arround','data_policy');method('QueryGenerator','getRuleMap','data_policy');method('QueryGenerator','installMplus','data_policy');}
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
 const operations:AuthOperation[]=[];
 for(const op of p.operations){
  if(op.role==='supporting'){supporting.push(op);continue;}
  const anchor=op.anchor||op.evidence.find(e=>nav.candidates.some(c=>['operation','sql'].includes(c.kind)&&c.evidence.file===e.file&&c.evidence.start_line>=e.start_line&&c.evidence.end_line<=e.end_line))||op.evidence[0];
  if(!anchor||!covers(anchor,reads)||!op.evidence.some(e=>e.file===anchor.file&&e.start_line<=anchor.start_line&&e.end_line>=anchor.end_line))throw new Error('operation_anchor_not_read');
  const canonical=[op.resource||'',op.action||'',anchor.file,anchor.start_line,anchor.end_line];const k=JSON.stringify(canonical);
  const existing=seen.get(k);if(existing){map.set(op.ref,existing.ref);existing.evidence=[...existing.evidence,...op.evidence].filter((e,i,arr)=>arr.findIndex(x=>JSON.stringify(x)===JSON.stringify(e))===i);continue;}
  op.anchor=anchor;op.canonical_key=canonical;seen.set(k,op);map.set(op.ref,op.ref);operations.push(op);
 }
 if(!operations.length)throw new Error('primary_business_operation_required');p.operations=operations;
 const coverage=auditCoverage(a,reads,nav,p.call_reviews||[]);
 const checks:typeof p.checks=[];
 for(const c of p.checks){
  c.operation_refs=c.operation_refs?.filter(r=>!supporting.some(o=>o.ref===r)).map(r=>map.get(r)||r);
  const core=!['validation','request_filter','observation'].includes(c.kind||'')&&!(c.kind==='query_scope'&&['request_only','unknown'].includes(c.scope_source||''));
  if(core&&operations.length>1&&(!c.operation_refs?.length||c.operation_refs.some(r=>!map.has(r)&&!operations.some(o=>o.ref===r))))throw new Error('explicit_operation_refs_required');
  const jwt=c.kind==='authentication'&&(/jwt/i.test(c.rule)||c.evidence.some(e=>/\/(JwtFilter|ShiroRealm)\.java$/.test(e.file)));
  const relevant=a.mechanisms.filter(m=>jwt?['route','authentication'].includes(m.role):c.kind==='action_permission'?m.role==='permission_advisor':c.kind==='query_scope'&&c.scope_source==='database_policy'?m.role==='data_policy':false);
  const unread=relevant.filter(m=>!coverage.mechanisms.find(x=>x.id===m.id)?.read_complete);
  const configMissing=core&&jwt&&a.conditions.length&&!c.conditions?.some(s=>/excludeUrls|匿名|anon/i.test(s));
  if(core&&(unread.length||configMissing)){
   const reason=configMissing?'配置依赖 external_anonymous_routes 未表达适用条件':'关键机制未完整核查：'+unread.map(m=>m.id).join(',');rejected.push({...c,reason});conditionIssues.push('检查候选未确认：'+reason);continue;
  }
  if(core&&c.execution==='unresolved'){rejected.push({...c,reason:'执行效果未明确'});conditionIssues.push('检查候选执行效果未明确：'+c.rule);continue;}
  if(core&&c.execution==='not_blocking'){rejected.push({...c,reason:'检查未阻止对应操作'});continue;}
  if(core&&c.execution==='enforced'){
   if(!c.effect_evidence?.length||!c.effect_evidence.every(e=>covers(e,reads)))throw new Error('enforcement_effect_evidence_required');
   if(c.effect_evidence.some(e=>nav.disabled.some(d=>d.file===e.file&&d.start_line<=e.start_line&&d.end_line>=e.end_line))){rejected.push({...c,reason:'执行效果证据位于已知关闭分支'});continue;}
   c.evidence=[...c.evidence,...c.effect_evidence].filter((e,i,arr)=>arr.findIndex(x=>JSON.stringify(x)===JSON.stringify(e))===i);
  }
  checks.push(c);
 }
 p.checks=checks;
 const triage:any[]=[];
 for(const r of p.unresolved_reviews||[]){
  if(!p.unresolved.includes(r.issue)||!r.reason.trim()||!r.evidence.length||!r.evidence.every(e=>covers(e,reads)))throw new Error('unresolved_review_not_evidenced');
  triage.push(r);if(r.disposition!=='blocking')p.unresolved=p.unresolved.filter(x=>x!==r.issue);
 }
 p.unresolved=[...new Set([...p.unresolved,...coverage.issues,...conditionIssues])];
 return {proposal:p,audit:{call_groups:coverage.groups,mechanisms:coverage.mechanisms,condition_dependencies:a.conditions,supporting_operations:supporting,operation_anchors:operations.map(o=>({ref:o.ref,anchor:o.anchor,resource:o.resource,action:o.action})),confirmed_checks:checks.filter(c=>!['validation','request_filter','observation'].includes(c.kind||'')&&!(c.kind==='query_scope'&&['request_only','unknown'].includes(c.scope_source||''))),unconfirmed_checks:rejected,unknown_reviews:triage,mandatory_unresolved:[...coverage.issues,...conditionIssues]}};
}
