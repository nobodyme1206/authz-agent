import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseSource,type JavaIndex} from './java-index.ts';
import {extractApis} from './spring.ts';
import {parseMapper,navigate,addBackendArtifacts,booleanCondition,type BackendIndex} from './authz-index.ts';
import {finalizeSubmission,runStage2,actualSourceReads} from './stage2.ts';
function index(files:Record<string,string>):BackendIndex{
 const classes=Object.entries(files).flatMap(([f,s])=>parseSource(s,f));const sources=new Map(Object.entries(files));
 return {classes,sources,files:[],diagnostics:[],sql:[],artifactDiagnostics:[],resolve(type,owner){const raw=type.replace(/<.*>/g,'');return classes.find(c=>c.fqn===raw||c.fqn===owner.pkg+'.'+raw||c.name===raw&&owner.imports.includes(c.fqn));}};
}
test('Mapper XML retains statement lines, dynamic predicates and include references without fetching DTDs',()=>{
 const sql=parseMapper('<?xml version="1.0"?>\n<!DOCTYPE mapper PUBLIC "x" "https://invalid.test/never-fetch.dtd">\n<mapper namespace="p.M">\n<sql id="scope"> tenant_id=#{tenant} </sql>\n<select id="rows">\n<include refid="scope"/><where><if test="user != null">user_id=#{user}</if><choose><when test="x">a=1</when><otherwise>b=2</otherwise></choose><foreach collection="ids">#{id}</foreach></where>\n</select>\n</mapper>','M.xml');
 assert.equal(sql[1].namespace,'p.M');assert.equal(sql[1].evidence.start_line,5);assert.equal(sql[1].evidence.end_line,7);assert.deepEqual(sql[1].includes,['scope']);assert.ok(sql[1].dynamic.includes('if:user != null'));
 assert.throws(()=>parseMapper('<!DOCTYPE mapper [<!ENTITY x SYSTEM "file:///secret">]><mapper/>','evil.xml'),/xml_entities_forbidden/);
});
test('method navigation resolves injected interfaces, exact scalar overloads and preserves ambiguity',()=>{
 const i=index({'C.java':'package p; @RestController class C { S service; @PostMapping("/x") void run(@RequestParam String id){service.go(id);} } interface S{void go(String id);} class Impl implements S {public void go(String id){helper(id);} void helper(String id){ } void helper(int n){} }'});
 const nav=navigate(i,extractApis(i,'rev')[0]);assert.ok(nav.nodes.some(n=>n.symbol==='p.Impl.go(String)'));assert.ok(nav.edges.some(e=>e.call==='helper'&&e.targets[0]==='p.Impl.helper(String)'));
 const other=parseSource('package p; class Other implements S {public void go(String id){ System.out.println(id);}}','Other.java');i.classes.push(...other);
 const n=navigate(i,extractApis(i,'rev')[0]);assert.ok(n.unresolved.some(u=>u.includes('不唯一')));
});
test('known false guards are inactive while branch and exception source remain visible',()=>{
 const i=index({'C.java':'package p; class Flags{static final Boolean ENABLED=false;} @RestController class C{ @PostMapping("/x") void run(@RequestParam String id){if(Flags.ENABLED && id!=null){throw new IllegalArgumentException();} try{if(id==null)throw new RuntimeException();}catch(Exception e){} save(id);} void save(String x){} }'});
 const nav=navigate(i,extractApis(i,'rev')[0]);assert.equal(nav.disabled.length,1);assert.ok(nav.candidates.some(c=>c.kind==='branch'&&c.inactive));assert.ok(nav.nodes.some(n=>n.symbol.includes('save')));
});
test('navigation limits record unresolved paths instead of silently truncating',()=>{
 const i=index({'C.java':'package p; @RestController class C{ @GetMapping("/x") void run(){a();} void a(){b();} void b(){a();}}'});const api=extractApis(i,'rev')[0];
 assert.ok(navigate(i,api,{depth:0,nodes:200}).unresolved.some(x=>x.includes('超过 0')));
 assert.ok(navigate(i,api,{depth:6,nodes:1}).unresolved.some(x=>x.includes('节点超过')));
});
test('authorization submissions require actual read evidence and fixed field references; disabled checks rejected',()=>{
 const i=index({'C.java':'package p; @RestController class C{ @PostMapping("/x") void run(@RequestParam String id){save(id);} void save(String id){} }'});const e=extractApis(i,'rev')[0],nav=navigate(i,e);const ev={file:'C.java',start_line:1,end_line:1};
 const p={operations:[{ref:'write',description:'Call save with target id',evidence:[ev]}],checks:[{fields:['query:id'],rule:'Target membership check, not owner check',evidence:[ev]}],scope:[],unresolved:[]};
 assert.throws(()=>finalizeSubmission(p,e,nav,i,[]),/evidence_not_read/);
 const data=finalizeSubmission(p,e,nav,i,[ev]);assert.equal(data.api_id,e.api.api_id);assert.ok(data.checks[0].id.startsWith('check-'));
 assert.throws(()=>finalizeSubmission({...p,checks:[{...p.checks[0],fields:['body:principal']}]},e,nav,i,[ev]),/unknown_field_reference/);
 nav.disabled=[ev];assert.throws(()=>finalizeSubmission(p,e,nav,i,[ev]),/disabled_branch/);
});
async function setup(){const root=await mkdtemp(path.join(os.tmpdir(),'authz-stage2-'));process.env.SNAPSHOT_ROOT=root;process.env.RUN_ROOT=path.join(root,'runs');await mkdir(path.join(root,'snap/src/main/java'),{recursive:true});const file='src/main/java/C.java';await writeFile(path.join(root,'snap',file),'package p; @RestController class C{ @PostMapping("/x") void run(@RequestParam String id){save(id);} void save(String id){} }');const i=index({[file]:'package p; @RestController class C{ @PostMapping("/x") void run(@RequestParam String id){save(id);} void save(String id){} }'});return {root,file,entry:extractApis(i,'rev')[0]};}
const config={baseUrl:'',modelId:'',apiKey:'',contextWindow:32000,maxTokens:4096,timeoutSeconds:90};
const limits={turns:12,tools:30,tokens:60000,modelSeconds:2,depth:6,nodes:200};
test('real Pi SDK structured analysis and program-assigned references persist, with no extra summary request',async()=>{
 const {createServer}=await import('node:http');const {file,entry}=await setup();let requests=0;let data:any;let detail:any;
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const input=JSON.parse(body);requests++;assert.ok(input.tools.every((t:any)=>!['bash','write','edit'].includes(t.function.name)));
 if(requests===2)assert.deepEqual(input.tools.map((t:any)=>t.function.name),['submit_authorization']);
 const submitted=input.messages.some((m:any)=>m.role==='tool');const ev={file:submitted?'f1':file,start_line:1,end_line:1};const name=submitted?'submit_authorization':'read_source_lines';const args=submitted?{operations:[{ref:'write',description:'Write target resource via save(id)',evidence:[ev]}],checks:[],scope:['controller and save'],unresolved:['implementation of persistence unavailable']}:{file,start_line:1,end_line:1};
 res.writeHead(200,{'Content-Type':'text/event-stream'});const chunk={id:'authz-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};
 res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 try{await runStage2({id:'livefixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,{...limits,tokens:180},async(route,b:any)=>{if(route.endsWith('/context'))return {source:entry,input_hash:'hash'};data=b.data;detail=structuredClone(b.detail);return {};},()=>{});
 assert.equal(requests,2);assert.equal(detail.analysis_complete,true);assert.equal(detail.tool_calls,2);assert.equal(data.operation.description,'Write target resource via save(id)');assert.equal(detail.usage.totalTokens,240);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('Stage 2 missing model retains program checkpoint and cancellation never starts model',async()=>{
 const {entry}=await setup();let last:any;
 const post=async(route:string,b:any)=>{if(route.endsWith('/context'))return {source:entry,input_hash:'hash'};last=structuredClone(b);return {};};
 await assert.rejects(()=>runStage2({id:'offline',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},config,new AbortController().signal,limits,post,()=>{}),/model_not_configured/);
 assert.equal(last.detail.phase,'failed');assert.ok(last.detail.graph);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>runStage2({id:'cancel',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},config,abort.signal,limits,post,()=>{}),/aborted/);
});

test('Stage 2 model failures and budgets stop paid calls and preserve conservative checkpoints',async()=>{
 const {createServer}=await import('node:http');
 for(const scenario of ['tokens','missing_usage','authentication','timeout','turns','tools'] as const){
  const {entry,file}=await setup();let requests=0;let last:any;
  const server=createServer(async(req,res)=>{for await(const _ of req){}requests++;
   if(scenario==='timeout')return;
   if(scenario==='authentication'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Invalid API key'}}));return;}
   const chunk={id:'limitfixture',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'r'+requests,type:'function',function:{name:'read_source_lines',arguments:JSON.stringify({file,start_line:1,end_line:1})}}]},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');
   if(scenario!=='missing_usage')res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
  try{
   await assert.rejects(()=>runStage2({id:scenario,snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,{...limits,tokens:scenario==='tokens'?100:60000,modelSeconds:scenario==='timeout'?.05:2,turns:scenario==='turns'?1:12,tools:scenario==='tools'?1:30},async(route,b:any)=>{if(route.endsWith('/context'))return {source:entry,input_hash:'hash'};last=structuredClone(b);return {};},()=>{}));
   assert.equal(last.detail.phase,'failed');assert.equal(last.detail.analysis_complete,false);assert.ok(requests<=(scenario==='tools'?2:1),scenario+': unexpected retry');
   assert.equal(last.detail.error,({tokens:'token_budget_exhausted',missing_usage:'model_usage_unavailable',authentication:'model_authentication_failed',timeout:'model_timeout',turns:'turn_budget_exceeded',tools:'tool_budget_exceeded'} as any)[scenario]);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 }
});

test('validation preconditions are separate from authorization checks and ambiguous field names are rejected',()=>{
 const i=index({'C.java':'package p; @RestController class C{ @PostMapping("/x") void run(@RequestParam String id){save(id);} void save(String id){} }'});const e=extractApis(i,'rev')[0],nav=navigate(i,e);const ev={file:'C.java',start_line:1,end_line:1};
 const p={operations:[{ref:'write',description:'Write target resource',evidence:[ev]}],checks:[{kind:'validation',fields:[],rule:'Target exists',evidence:[ev]},{kind:'resource_relation',fields:['id'],rule:'Check target membership',evidence:[ev]}],scope:[],unresolved:[]};
 const data=finalizeSubmission(p,e,nav,i,[ev]);assert.equal(data.checks.length,1);assert.deepEqual(data.checks[0].fields.sort(),['form:id','query:id']);
 const amb=structuredClone(e);amb.api.request_fields=[{name:'id',location:'body',type:'string',evidence:[ev]},{name:'id',location:'query',type:'string',evidence:[ev]}];
 const bad=structuredClone(p);bad.checks[1].fields=['id'];assert.throws(()=>finalizeSubmission(bad,amb,nav,i,[ev]),/unknown_field_reference/);
});

test('static false guards short-circuit opaque function calls in global security mechanisms',()=>{
 const i=index({'C.java':'package p; class Flags{static final boolean ENABLED=false;} class ShiroRealm{void login(String user){if(Flags.ENABLED && unknown(user)){deny();}} boolean unknown(String x){return true;} void deny(){}} @RestController class C{@GetMapping("/x") void run(){}}'});const e=extractApis(i,'rev')[0],nav=navigate(i,e);
 assert.ok(nav.disabled.some(e=>e.file==='C.java'));assert.ok(nav.candidates.some(c=>c.inactive&&c.description.includes('unknown')));
});

test('client-only SQL filters and anonymous observations cannot become enforced scope checks',()=>{
 const i=index({'C.java':'package p; @RestController class C{@GetMapping("/x") void run(@RequestParam String id){}}'}),e=extractApis(i,'rev')[0],nav=navigate(i,e),ev={file:'C.java',start_line:1,end_line:1};
 const p={operations:[{ref:'query',description:'Read rows matching input id',evidence:[ev]}],checks:[{kind:'query_scope',scope_source:'request_only',fields:['query:id'],rule:'Only filter from request id',evidence:[ev]},{kind:'observation',fields:[],rule:'Anonymous route exception',evidence:[ev]}],scope:[],unresolved:[]};
 assert.equal(finalizeSubmission(p,e,nav,i,[ev]).checks.length,0);
 const unknown=structuredClone(p);unknown.checks[0].scope_source='unknown';assert.ok(finalizeSubmission(unknown,e,nav,i,[ev]).unresolved.length);
});

test('evidence can span contiguous actual reads but never an unread gap',async()=>{
 const {observedRange}=await import('./stage2.ts');const e={file:'A.java',start_line:79,end_line:102};
 assert.ok(observedRange(e,[{file:'A.java',start_line:1,end_line:100},{file:'A.java',start_line:99,end_line:112}]));
 assert.equal(observedRange(e,[{file:'A.java',start_line:1,end_line:90},{file:'A.java',start_line:92,end_line:112}]),false);
});

test('program navigation locations never count as model source reads, including checkpoint reuse',()=>{
 const e={file:'C.java',start_line:8,end_line:8},real={file:'C.java',start_line:1,end_line:20};
 const detail={observed:[e,real],candidates:[{kind:'operation',description:'save(id)',evidence:e}]};
 assert.deepEqual(actualSourceReads(detail),[real]);assert.deepEqual(detail.observed,[e,real]);
 assert.deepEqual(actualSourceReads({...detail,observed:[e]}),[]);
 assert.deepEqual(actualSourceReads({...detail,agent_observed:[e]}),[e]);
});

test('same fully qualified Controller in different modules resolves by frozen source file',()=>{
 const i=index({'module-a/C.java':'package p; @RestController class C{@GetMapping("/x") void run(){}}','module-b/C.java':'package p; @RestController class C{@GetMapping("/x") void run(){}}'});
 const b=extractApis(i,'rev').find(e=>e.api.file==='module-b/C.java')!;assert.equal(navigate(i,b).entry.owner.file,'module-b/C.java');
});

test('Java Mapper SQL annotations are linked to namespace and method without executing providers',async()=>{
 const {root}=await setup();const java=index({'src/main/java/M.java':'package p; interface M{@Select("select * from resource where user_id=#{user}") Object rows(String user); @SelectProvider(type=Provider.class,method="sql") Object dynamic(String id);}'});
 const enriched=await addBackendArtifacts(path.join(root,'snap'),java,new AbortController().signal);
 assert.deepEqual(enriched.sql.map(s=>[s.namespace,s.id,s.kind]),[['p.M','rows','select'],['p.M','dynamic','selectprovider']]);assert.ok(enriched.sql[1].dynamic.includes('provider_source_requires_review'));
});

test('an unmatched Spring qualifier never selects the only unrelated local implementation',()=>{
 const i=index({'C.java':'package p; interface S { void go(String id); } class Impl implements S {public void go(String id){}} @RestController class C{@Qualifier("externalBean") S service; @GetMapping("/x") void run(@RequestParam String id){service.go(id);}}'});const nav=navigate(i,extractApis(i,'rev')[0]);assert.equal(nav.edges.find(e=>e.call==='service.go')?.status,'unresolved');assert.ok(!nav.nodes.some(n=>n.symbol==='p.Impl.go(String)'));
});
test('AND/OR annotation and late/caught guard ordering remain available as source evidence, not invented enforcement',()=>{
 const i=index({'C.java':'package p; @RestController class C{\n@RequiresPermissions(value={"read","write"},logical=Logical.OR)\n@GetMapping("/x") void run(@RequestParam String id){\nsave(id);\ntry{if(id==null)throw new RuntimeException();}catch(Exception ignored){}\n}\nvoid save(String id){}\n}'});const nav=navigate(i,extractApis(i,'rev')[0]);assert.ok(nav.candidates.some(c=>c.kind==='annotation'&&c.description.includes('logical=Logical.OR')));
 const guard=nav.candidates.find(c=>c.kind==='branch')!;const write=nav.edges.find(e=>e.call==='save')!;assert.ok(write.line<guard.evidence.start_line);assert.equal(guard.inactive,false);
});
