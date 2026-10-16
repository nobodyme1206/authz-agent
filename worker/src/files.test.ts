import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,mkdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {safePath,readLines,listFiles,redact,classifyError} from './files.ts';
import {runProbe} from './probe.ts';
import {createServer} from 'node:http';

test('source tools reject escapes, links, binary data and invalid lines',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'authz-files-'));
 await writeFile(path.join(root,'a.txt'),'one\ntwo\n');
 await writeFile(path.join(root,'b.bin'),Buffer.from([255,254]));
 await symlink('/etc/passwd',path.join(root,'escape'));
 assert.equal((await readLines(root,'a.txt',1,2)).content,'one\ntwo');
 assert.equal((await listFiles(root)).entries.some(e=>e.name==='escape'),false);
 for(const f of ['../secret','/etc/passwd','escape']) await assert.rejects(()=>safePath(root,f));
 for(const [a,b] of [[0,1],[2,1],[1,3],[1,200]])await assert.rejects(()=>readLines(root,'a.txt',a,b));
 await assert.rejects(()=>readLines(root,'b.bin',1,1));
});
test('errors and credentials are safe for public output',()=>{
 assert.equal(redact('token abc123 Bearer secret',['abc123']),'token [REDACTED] Bearer [REDACTED]');
 assert.equal(classifyError(new Error('401 secret-value')),'model_authentication_failed');
 assert.equal(classifyError(new Error('HTTP 400 tool_call unsupported')),'model_interface_incompatible');
});

test('Pi integration against controlled protocol fixtures (not live model validation)',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'authz-pi-'));
 process.env.SNAPSHOT_ROOT=path.join(root,'snapshots');process.env.RUN_ROOT=path.join(root,'runs');
 await mkdir(path.join(root,'snapshots','snap-test','.pi','extensions'),{recursive:true});
 await writeFile(path.join(root,'snapshots','snap-test','README.md'),'fixture first line\n');
 await writeFile(path.join(root,'snapshots','snap-test','.pi','extensions','malicious.ts'),'throw new Error("REPO_EXTENSION_WAS_LOADED");');
 let mode='success',requests=0;
 const server=createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   requests++;
   if(mode==='auth'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'unauthorized test-secret'}}));return;}
   if(mode==='bad'){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'unsupported tool calls'}}));return;}
   if(mode==='hang'){return;}
   const input=JSON.parse(body);
   assert.deepEqual(input.tools.map((t:any)=>t.function.name).sort(),['list_source_files','read_source_lines']);
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const send=(delta:unknown,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta,finish_reason}]})+'\n\n');
   if(input.messages.some((m:any)=>m.role==='tool')){
      send({role:'assistant',content:'README.md:1 — fixture first line'});send({},'stop');
   }else{
      send({role:'assistant',tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read_source_lines',arguments:JSON.stringify({file:'README.md',start_line:1,end_line:1})}}]});send({},'tool_calls');
   }
   res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const addr=server.address() as {port:number};
 const config={baseUrl:`http://127.0.0.1:${addr.port}/v1`,modelId:'fixture-model',apiKey:'test-secret',contextWindow:32000,maxTokens:256,timeoutSeconds:3};
 const job={id:'probe-test',snapshot_id:'snap-test',file:'README.md',source_revision:'fixture'};
 try{
   const result=await runProbe(job,config,()=>{},AbortSignal.timeout(15000));
   assert.equal(result.kind,'agent_probe');assert.equal(result.reads[0].file,'README.md');assert.ok(requests>=2);
   mode='auth';await assert.rejects(()=>runProbe({...job,id:'auth'},config,()=>{},AbortSignal.timeout(10000)),/401|unauthorized|auth/i);
   assert.equal((await readFile(path.join(root,'runs','auth','pi','transcript.json'),'utf8')).includes('test-secret'),false);
   mode='bad';await assert.rejects(()=>runProbe({...job,id:'bad'},config,()=>{},AbortSignal.timeout(10000)),/400|unsupported/i);
   mode='hang';await assert.rejects(()=>runProbe({...job,id:'hang'},config,()=>{},AbortSignal.timeout(400)));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
