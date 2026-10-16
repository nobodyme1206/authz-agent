import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runStage1} from './stage1.ts';
import {mergeDelta} from './enrich.ts';
import {buildIndex} from './java-index.ts';
import {extractApis} from './spring.ts';
async function setup(){const root=await mkdtemp(path.join(os.tmpdir(),'authz-stage1-'));process.env.SNAPSHOT_ROOT=root;process.env.RUN_ROOT=path.join(root,'runs');await mkdir(path.join(root,'snap/src/main/java'),{recursive:true});await writeFile(path.join(root,'snap/src/main/java/C.java'),'@RestController class C { @PostMapping("/x") public void run(@RequestBody JSONObject body){String key="extra"; body.getString(key); Map server=new HashMap(); server.get("secret");}}');return root;}
const config={baseUrl:'',modelId:'',apiKey:'',contextWindow:32000,maxTokens:4096,timeoutSeconds:90};
const limits={apis:1,turns:6,tools:12,apiTimeout:1,tokens:100000};
test('missing model preserves deterministic checkpoint and explicit skip metadata; resume keeps stable IDs',async()=>{
 const root=await setup();const saved:any[]=[];let scan:any;
 const post=async(route:string,body:any)=>{if(route.endsWith('/base'))return saved;for(const e of body.entries||[])saved.push(e);if(body.scan)scan=structuredClone(body.scan);return {ok:true};};
 const job={id:'run',snapshot_id:'snap',source_revision:'rev',kind:'stage1_extract',options:{enrich:true}};
 await runStage1(job,config,new AbortController().signal,limits,post,()=>{});
 assert.equal(scan.files.length,1);assert.equal(scan.index_complete,true);assert.equal(scan.phase,'finished');assert.equal(scan.enrichment.skipped,1);assert.equal(scan.enrichment.stop_reason,'model_not_configured');
 const id=saved[0].api.api_id;
 await runStage1({...job,id:'resume',options:{enrich:false,base_run_id:'run'}},config,new AbortController().signal,limits,post,()=>{});
 assert.equal(saved.at(-1).api.api_id,id);
});
test('model proposals cannot introduce reads from server-only local maps',async()=>{
 const root=await setup();const index=await buildIndex(path.join(root,'snap'),[],new AbortController().signal);const e=extractApis(index,'rev')[0];const ev={file:e.api.file,start_line:1,end_line:1};
 const good=mergeDelta(e,{fields:[{name:'extra',location:'body',type:'string',evidence:[ev]}],resolved:[],unresolved:[]},[ev],index);
 assert.equal(good.detail.enrichment_accepted,1);assert.equal(good.api.request_fields[0].name,'extra');
 const bad=mergeDelta(e,{fields:[{name:'secret',location:'body',type:'string',evidence:[ev]}],resolved:[],unresolved:[]},[ev],index);
 assert.equal(bad.detail.enrichment_accepted,0);
});
test('cancellation interrupts scanning without starting a model',async()=>{
 await setup();const abort=new AbortController();abort.abort();let calls=0;
 await assert.rejects(()=>runStage1({id:'cancel',snapshot_id:'snap',source_revision:'rev',kind:'stage1_extract',options:{}},config,abort.signal,limits,async()=>{calls++;},()=>{}),/aborted/);
 assert.equal(calls,0);
});

test('Pi structured submissions are validated and API budget stops subsequent APIs',async()=>{
 const {createServer}=await import('node:http');const root=await setup();
 await writeFile(path.join(root,'snap/src/main/java/C.java'),'@RestController class C { @PostMapping("/x") public void run(@RequestBody JSONObject body){String key="extra"; body.getString(key);}\n@PostMapping("/y") public void more(@RequestBody JSONObject body){String key="extra"; body.getString(key);}}');
 let requests=0;
 const server=createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;const input=JSON.parse(body);requests++;
  assert.deepEqual(input.tools.map((x:any)=>x.function.name).sort(),['find_symbol','list_source_files','read_source_lines','search_source','submit_fields']);
  const responses=input.messages.filter((x:any)=>x.role==='tool');
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(delta:unknown,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'stagefixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
  if(!responses.length){send({role:'assistant',tool_calls:[{index:0,id:'read',type:'function',function:{name:'read_source_lines',arguments:JSON.stringify({file:'src/main/java/C.java',start_line:1,end_line:2})}}]});send({},'tool_calls');}
  else if(responses.length===1){send({role:'assistant',tool_calls:[{index:0,id:'submit',type:'function',function:{name:'submit_fields',arguments:JSON.stringify({fields:[{name:'extra',location:'body',type:'string',evidence:[{file:'src/main/java/C.java',start_line:1,end_line:1}]}],resolved:[],unresolved:[]})}}]});send({},'tool_calls');}
  else{send({role:'assistant',content:'Submitted only the input-backed field.'});send({},'stop');}
  res.write('data: '+JSON.stringify({id:'stagefixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}})+'\n\n');res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 let scan:any;const entries=new Map<string,any>();
 try{
  await runStage1({id:'structured',snapshot_id:'snap',source_revision:'rev',kind:'stage1_extract',options:{enrich:true}},{...config,baseUrl:`http://127.0.0.1:${port}/v1`,modelId:'fixture',apiKey:'fixture-only'},new AbortController().signal,{...limits,apis:1,tokens:100000},async(_r,b:any)=>{if(b.scan)scan=structuredClone(b.scan);for(const e of b.entries||[])entries.set(e.api.api_id,e);return {};},()=>{});
  assert.equal(scan.enrichment.attempted,1);assert.equal(scan.enrichment.accepted_fields,1);assert.equal(scan.enrichment.stop_reason,'api_budget_exhausted');assert.equal(scan.enrichment.skipped,1);assert.ok(scan.usage.totalTokens>0);assert.equal(requests,2);
  assert.ok([...entries.values()].some(e=>e.api.request_fields.some((f:any)=>f.name==='extra')));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('Stage 1 preserves program results when token usage is exhausted, missing, or the model rejects authentication', async()=>{
 const {createServer}=await import('node:http');
 for(const scenario of ['tokens','missing_usage','authentication'] as const){
  const root=await setup();
  await writeFile(path.join(root,'snap/src/main/java/C.java'),'@RestController class C { @PostMapping("/x") public void run(@RequestBody JSONObject body){String key="extra"; body.getString(key);}\n@PostMapping("/y") public void more(@RequestBody JSONObject body){String key="extra"; body.getString(key);}}');
  let requests=0;
  const server=createServer(async(req,res)=>{
   for await(const _chunk of req){} requests++;
   if(scenario==='authentication'){
    res.writeHead(401,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:'Invalid API key',type:'authentication_error'}}));return;
   }
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const chunk={id:'budgetfixture',object:'chat.completion.chunk',created:1,model:'fixture'};
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'read',type:'function',function:{name:'read_source_lines',arguments:JSON.stringify({file:'src/main/java/C.java',start_line:1,end_line:2})}}]},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');
   if(scenario==='tokens')res.write('data: '+JSON.stringify({...chunk,choices:[],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}})+'\n\n');
   res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port;
  let scan:any;const entries=new Map<string,any>();
  try{
   await runStage1({id:'budget-'+scenario,snapshot_id:'snap',source_revision:'rev',kind:'stage1_extract',options:{enrich:true}},{...config,baseUrl:`http://127.0.0.1:${port}/v1`,modelId:'fixture',apiKey:'fixture-only'},new AbortController().signal,{...limits,apis:20,tokens:scenario==='tokens'?10:100000},async(_route,b:any)=>{if(b.scan)scan=structuredClone(b.scan);for(const e of b.entries||[])entries.set(e.api.api_id,e);return {};},()=>{});
   assert.equal(requests,1,scenario+' must not start another model call');
   assert.equal(scan.enrichment.attempted,1);assert.equal(entries.size,2);
   assert.equal(scan.enrichment.stop_reason,scenario==='tokens'?'token_budget_exhausted':scenario==='missing_usage'?'model_usage_unavailable':'model_authentication_failed');
   assert.ok([...entries.values()].every(e=>e.api.unresolved.length>0));
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 }
});
