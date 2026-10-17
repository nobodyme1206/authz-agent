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
 if(requests===2){assert.ok(input.tools.some((t:any)=>t.function.name==='submit_authorization'));assert.ok(input.tools.some((t:any)=>t.function.name==='read_source_lines'));}
 const submitted=input.messages.some((m:any)=>m.role==='tool');const ev={file:submitted?'f1':file,start_line:1,end_line:1};const name=submitted?'submit_authorization':'get_analysis_bundle';const args=submitted?{operations:[{ref:'write',description:'Write target resource via save(id)',evidence:[ev]}],checks:[],scope:['controller and save'],unresolved:['implementation of persistence unavailable']}:{};
 res.writeHead(200,{'Content-Type':'text/event-stream'});const chunk={id:'authz-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};
 res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 try{await runStage2({id:'livefixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,{...limits,tokens:60000,tools:4},async(route,b:any)=>{if(route.endsWith('/context'))return {source:entry,input_hash:'hash'};data=b.data;detail=structuredClone(b.detail);return {};},()=>{});
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
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'r'+requests,type:'function',function:{name:'get_analysis_bundle',arguments:JSON.stringify({})}}]},finish_reason:null}]})+'\n\n');
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

test('invalid fields and rejected saves never poison the last valid checkpoint or lose final usage',async()=>{
 for(const scenario of ['invalid_fields','save_rejected']){
 const {createServer}=await import('node:http');const {entry,file}=await setup();let requests=0;let last:any;
 const server=createServer(async(req,res)=>{for await(const _ of req){}requests++;const submitted=requests>1;const ev={file,start_line:1,end_line:1};const name=submitted?'submit_authorization':'get_analysis_bundle';
 const args=submitted?{operations:[{ref:'write',description:'Write via save',evidence:[ev]}],checks:[{kind:'authentication',operation_refs:['write'],fields:[scenario==='invalid_fields'?'body:invented':'query:id'],rule:'Test invalid reference',execution:'enforced',effect_evidence:[ev],evidence:[ev]}],scope:[],unresolved:[]}:{};
 const chunk={id:'invalid-submission',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'c'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address()as{port:number}).port;
 try{await assert.rejects(()=>runStage2({id:'invalid-reference-fixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,{...limits,turns:2},async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash'};if(scenario==='save_rejected'&&b.detail.analysis_complete)throw new Error('invalid_stage2_record');if(b.data)assert.ok((b.detail.mandatory_unresolved||[]).every((x:string)=>b.data.unresolved.includes(x)));last=structuredClone(b);return{};},()=>{}));assert.equal(requests,2);assert.equal(last.detail.phase,'failed');assert.equal(last.detail.analysis_complete,false);assert.equal(last.detail.usage.totalTokens,240);assert.equal(last.detail.audit,undefined);assert.ok(last.data.operations);}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 }
});

test('provider reservation and SDK schema failures cannot bypass per-request limits',async()=>{
 const {createServer}=await import('node:http');
 for(const scenario of ['reservation','invalid_schema'] as const){
  const {entry,file}=await setup();let requests=0;let last:any;
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests++;
   if(scenario==='invalid_schema'&&requests===2){const payload=JSON.parse(body);const errors=payload.messages.filter((m:any)=>m.role==='tool');assert.ok(errors.length||JSON.stringify(payload.messages).includes('sdk_submission_rejected'));assert.ok(errors.every((m:any)=>!JSON.stringify(m.content).includes('Received arguments:')));}
   const name=scenario==='reservation'?'get_analysis_bundle':'submit_authorization';
   const args=scenario==='reservation'?{}:{operations:[],checks:[{kind:'authentication'}]};
   const chunk={id:'guard-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'c'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as{port:number}).port;
  try{
   await assert.rejects(()=>runStage2({id:scenario,snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,{...limits,turns:2,tokens:scenario==='reservation'?2000:60000},async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash'};last=structuredClone(b);return{};},()=>{}));
   assert.equal(requests,scenario==='reservation'?1:2);assert.equal(last.detail.error,scenario==='reservation'?'token_budget_reserve_exhausted':'turn_budget_exceeded');assert.equal(last.detail.usage.totalTokens,requests*120);assert.equal(last.detail.analysis_complete,false);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 }
});

test('optional review drafts are separate from compact final submission and cannot erase unknowns without proof',async()=>{
 const {createServer}=await import('node:http');const {entry,file}=await setup();let requests=0;let last:any;
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests++;const input=JSON.parse(body),submit=input.tools.find((t:any)=>t.function.name==='submit_authorization');
 if(submit)assert.deepEqual(Object.keys(submit.function.parameters.properties).sort(),['checks','inactive_candidates','observations','operations','scope','unresolved']);
 const name=requests===1?'read_source_lines':requests===2?'record_analysis_notes':'submit_authorization';const e={file,start_line:1,end_line:1};
 const args=requests===1?e:requests===2?{mechanism_reviews:[{id:'not-a-mechanism',reason:'unverified optional statement',evidence:[e]}],unresolved_reviews:[{issue:'remaining helper',disposition:'deferred',reason:'attempt to remove without read proof',evidence:[{...e,start_line:90,end_line:90}]}]}:{unresolved:['remaining helper'],scope:['entry'],operations:[{ref:'write',description:'Save requested record',evidence:[e]}],checks:[]};
 const chunk={id:'notes-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'c'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as{port:number}).port;
 try{await runStage2({id:'notes-fixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,limits,async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash',base:{detail:{}}};last=structuredClone(b);return{};},()=>{});
 assert.equal(requests,3);assert.equal(last.detail.analysis_complete,true);assert.equal(last.detail.audit.rejected_reviews.length,2);assert.ok(last.data.unresolved.includes('remaining helper'));assert.equal(last.detail.review_draft.mechanism_reviews.length,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('bounded source bundle supports a two-reply Pi analysis and sequential notes before submission',async()=>{
 const {createServer}=await import('node:http');const {entry,file}=await setup();let requests=0;let last:any;
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests++;const input=JSON.parse(body);
 if(requests===2){const source=input.messages.filter((m:any)=>m.role==='tool').map((m:any)=>JSON.stringify(m.content)).join('');assert.ok(source.includes('save(id)'));}
 const e={file:'f1',start_line:1,end_line:1};const calls=requests===1?[{name:'get_analysis_bundle',args:{}}]:[{name:'record_analysis_notes',args:{observations:['No policy inferred; only source read proof fixture']}},{name:'submit_authorization',args:{unresolved:[],scope:['entry and implementation'],operations:[{ref:'save',description:'Observed save(id) source call',anchor:e,evidence:[e]}],checks:[]}}];
 const chunk={id:'bundle-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:calls.map((c,i)=>({index:i,id:'c'+requests+'-'+i,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as{port:number}).port;
 try{await runStage2({id:'bundle-fixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,limits,async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash',base:{data:{api_id:entry.api.api_id,operation:{description:'Prior read checkpoint',evidence:[{file,start_line:1,end_line:1}]},checks:[],scope:[file],unresolved:[]},detail:{observed:[{file,start_line:1,end_line:1}],agent_observed:[{file,start_line:1,end_line:1}]}}};last=structuredClone(b);return{};},()=>{});
 assert.equal(requests,2);assert.equal(last.detail.analysis_complete,true);assert.equal(last.detail.bundle_read,true);assert.equal(last.detail.tool_calls,3);assert.equal(last.detail.observations[0],'No policy inferred; only source read proof fixture');assert.ok(last.detail.agent_observed.some((e:any)=>e.file===file));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('initial tasks can perform a focused read after the bundle before final submission',async()=>{
 const {createServer}=await import('node:http');const {entry,file}=await setup();let requests=0;let last:any;
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests++;const input=JSON.parse(body);
 if(requests===2)assert.ok(input.tools.some((t:any)=>t.function.name==='read_source_lines'));
 const e={file,start_line:1,end_line:1};const name=requests===1?'get_analysis_bundle':requests===2?'read_source_lines':'submit_authorization';
 const args=requests===1?{}:requests===2?{file,start_line:1,end_line:1}:{operations:[{ref:'save',description:'Observed save(id)',anchor:e,evidence:[e]}],checks:[],scope:['read source'],unresolved:[]};
 const chunk={id:'focused-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'focused'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as{port:number}).port;
 try{await runStage2({id:'focused-fixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,limits,async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash'};last=structuredClone(b);return{};},()=>{});
 assert.equal(requests,3);assert.equal(last.detail.analysis_complete,true);assert.equal(last.detail.tool_calls,3);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('one correction uses bounded actual source, accepts proof IDs and retains prior uncertainties',async()=>{
 const {createServer}=await import('node:http');const {entry,file}=await setup();let requests=0;let last:any;let proof='';
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests++;const input=JSON.parse(body);
 if(requests===2){const msg=input.messages.find((m:any)=>m.role==='tool');const v=JSON.parse(msg.content);proof=v.proof_catalog.find((r:any)=>r.kind==='operation')?.id||v.proof_catalog[0].id;}
 if(requests===3){assert.equal(input.messages.length,1);const content=input.messages[0].content;const compact=JSON.parse(typeof content==='string'?content:content[0].text);assert.ok(compact.error.includes('binding_source_mismatch'));assert.ok(compact.source.blocks.some((b:any)=>b.content.includes('save(id)')));assert.ok(compact.field_refs.includes('query:id'));}
 const ev={file,start_line:1,end_line:1};const name=requests===1?'get_analysis_bundle':'submit_authorization';
 const args=requests===1?{}:{operations:[{ref:'save',description:'Save target',...(requests===3?{evidence_ids:[proof]}:{evidence:[ev]})}],checks:requests===2?[{kind:'resource_relation',fields:['query:id'],rule:'Target relationship',execution:'enforced',evidence:[ev],effect_evidence:[ev],operation_refs:['save'],bindings:[{symbol:'id',source:'body:id'}]}]:[],scope:['entry'],unresolved:requests===2?['pending helper review']:[]};
 const chunk={id:'repair-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'repair'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as{port:number}).port;
 try{await runStage2({id:'repair-fixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,limits,async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash'};last=structuredClone(b);return{};},()=>{});
 assert.equal(requests,3);assert.equal(last.detail.analysis_complete,true);assert.equal(last.detail.repair_context_used,true);assert.ok(last.data.unresolved.includes('pending helper review'));assert.equal(last.detail.submission_errors.length,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('SDK truncated submissions enter one compact correction and force final tool selection',async()=>{
 const {createServer}=await import('node:http');const {entry,file}=await setup();let requests=0;let last:any;
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests++;const input=JSON.parse(body);
 if(requests===3){assert.equal(input.tool_choice,'required');assert.ok(JSON.stringify(input.messages).includes('sdk_submission_rejected'));assert.ok(JSON.stringify(input.messages).includes('save(id)'));}
 const e={file,start_line:1,end_line:1};const name=requests===1?'get_analysis_bundle':'submit_authorization';const args=requests===1?{}:{operations:[{ref:'save',description:'Save requested entity',evidence:[e]}],checks:[],scope:['entry'],unresolved:[]};
 const chunk={id:'sdk-truncated',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'trunc'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:requests===2?'length':'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as{port:number}).port;
 try{await runStage2({id:'sdk-truncated',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,limits,async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash'};last=structuredClone(b);return{};},()=>{});
 assert.equal(requests,3);assert.equal(last.detail.analysis_complete,true);assert.equal(last.detail.repair_context_used,true);assert.equal(last.detail.submission_errors[0].code,'sdk_submission_rejected');assert.ok(last.detail.provider_requests.some((p:any)=>p.tool_choice==='required'));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('SDK context pressure compacts delivered source and retains full configured output room',async()=>{
 const {createServer}=await import('node:http');const {file,root}=await setup();const source='package p;\n@RestController class C{\n @PostMapping("/x")\n void run(@RequestParam String id){\n save(id);\n'+'// '+('context '.repeat(65)+'\n// ').repeat(140)+'\n }\n void save(String id){}\n}';
 await writeFile(path.join(root,'snap',file),source);const entry=extractApis(index({[file]:source}),'rev')[0];let requests=0;let last:any;
 const server=createServer(async(req,res)=>{for await(const c of req){}requests++;const ev={file,start_line:5,end_line:5};const name=requests===1?'get_analysis_bundle':'submit_authorization';const args=requests===1?{}:{operations:[{ref:'save',description:'Observed save(id)',evidence:[ev]}],checks:[],scope:['visible source'],unresolved:['method tail remains unreviewed']};const chunk={id:'context-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'ctx'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as{port:number}).port;
 try{await runStage2({id:'context-fixture',snapshot_id:'snap',source_revision:'rev',options:{api_id:entry.api.api_id,stage1_run_id:'s1',input_hash:'hash'}},{...config,contextWindow:24000,apiKey:'fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`},new AbortController().signal,limits,async(route,b:any)=>{if(route.endsWith('/context'))return{source:entry,input_hash:'hash'};last=structuredClone(b);return{};},()=>{});assert.equal(requests,2);assert.equal(last.detail.compact_source_view_used,true);assert.equal(last.detail.provider_requests.at(-1).max_output_tokens,4096);assert.equal(last.detail.analysis_complete,true);assert.ok(last.data.unresolved.includes('method tail remains unreviewed'));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
