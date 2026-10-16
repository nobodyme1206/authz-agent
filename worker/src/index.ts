import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runProbe, type ModelConfig, type ProbeJob } from './probe.ts';
import { classifyError } from './files.ts';
import { runStage1, type StageJob } from './stage1.ts';
import { runStage2, type AuthJob } from './stage2.ts';
const api=process.env.API_URL || 'http://api:8000';
const boot=randomUUID();
const identity={key:'primary',boot};
const runRoot=process.env.RUN_ROOT || '/runs';
let stopping=false;
let activeAbort:AbortController|undefined;
process.on('SIGTERM',()=>{stopping=true;activeAbort?.abort();});
process.on('SIGINT',()=>{stopping=true;activeAbort?.abort();});
async function fileSecret(name:string){try{return (await readFile(process.env[name]||'/nonexistent','utf8')).trim();}catch{return '';}}
const token=await fileSecret('INTERNAL_TOKEN_FILE');
if(!token) throw new Error('internal_token_missing');
const config:ModelConfig={baseUrl:process.env.MODEL_BASE_URL||'',modelId:process.env.MODEL_ID||'',apiKey:await fileSecret('MODEL_API_KEY_FILE'),contextWindow:Number(process.env.MODEL_CONTEXT_WINDOW||32000),maxTokens:Number(process.env.MODEL_MAX_TOKENS||2048),timeoutSeconds:Number(process.env.PROBE_TIMEOUT_SECONDS||90)};
const configured=Boolean(config.baseUrl&&config.modelId&&config.apiKey);
// Public state contains no endpoint credentials or API key.
const modelStatus={configured,model_id:config.modelId||null,provider:'openai-compatible',state:configured?'configured':'not_configured'};
function setting(name:string,fallback:number){const n=Number(process.env[name]||fallback);if(!Number.isFinite(n)||n<=0)throw new Error('invalid_worker_limit');return n;}
const limits={apis:setting('STAGE1_MAX_ENRICH_APIS',20),turns:setting('STAGE1_MAX_TURNS',6),tools:setting('STAGE1_MAX_TOOLS',12),apiTimeout:setting('STAGE1_API_TIMEOUT_SECONDS',120),tokens:setting('STAGE1_TOKEN_BUDGET',100000)};
async function post(route:string,body:unknown):Promise<any>{
  const r=await fetch(api+route,{method:'POST',headers:{'Content-Type':'application/json','X-Worker-Token':token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw new Error(`internal_http_${r.status}`);
  return r.json();
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
await mkdir(runRoot,{recursive:true});
let registered=false;
while(!stopping){
  try{
    if(!registered){await post('/internal/worker/start',{...identity,model:modelStatus});registered=true;}
    await writeFile(runRoot+'/worker-health.json',JSON.stringify({seen:Date.now()}));
    const job:(ProbeJob & StageJob & AuthJob)|null=await post('/internal/jobs/claim',identity);
    if(!job){await sleep(1500);continue;}
    const abort=new AbortController();activeAbort=abort;
    let cancelled=false,timedOut=false,ownershipLost=false;
    const queue:Array<{type:string;data:Record<string,unknown>}>=[];
    let pump:Promise<void>=Promise.resolve();
    const drain=()=>{pump=pump.then(async()=>{while(queue.length){const e=queue[0];await post(`/internal/jobs/${job.id}/events`,{...identity,...e});queue.shift();}}).catch(()=>{ownershipLost=true;abort.abort();});return pump;};
    const timer=setTimeout(()=>{timedOut=true;abort.abort();},(job.kind==='stage2_analyze'?setting('STAGE2_TIMEOUT_SECONDS',300):job.kind==='stage1_extract'?setting('STAGE1_TIMEOUT_SECONDS',1800):config.timeoutSeconds)*1000);
    let heartbeatBusy=false;
    const heartbeat=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;void (async()=>{
      try{await writeFile(runRoot+'/worker-health.json',JSON.stringify({seen:Date.now()}));const state=await post(`/internal/jobs/${job.id}/heartbeat`,identity);if(state.state==='cancel_requested'){cancelled=true;abort.abort();}await drain();}
      catch{ownershipLost=true;abort.abort();}
      finally{heartbeatBusy=false;}
    })();},2000);
    let result:unknown=null,error:string|null=null,state='failed';
    try{
      const emit=(type:string,data:Record<string,unknown>)=>queue.push({type,data});
      result=job.kind==='stage2_analyze'
        ?await runStage2(job,{...config,maxTokens:setting('STAGE2_MAX_OUTPUT_TOKENS',4096)},abort.signal,{turns:setting('STAGE2_MAX_TURNS',12),tools:setting('STAGE2_MAX_TOOLS',30),tokens:setting('STAGE2_TOKEN_BUDGET',60000),modelSeconds:setting('STAGE2_MODEL_TIMEOUT_SECONDS',180),depth:setting('STAGE2_CALL_DEPTH',6),nodes:setting('STAGE2_CALL_NODES',200)},(route,body)=>post(route,{...identity,...body}),emit)
        :job.kind==='stage1_extract'
        ?await runStage1(job,{...config,maxTokens:setting('STAGE1_MAX_OUTPUT_TOKENS',4096)},abort.signal,limits,(route,body)=>post(route,{...identity,...body}),emit)
        :await runProbe(job,config,emit,abort.signal);
      state='completed';
    }
    catch(e){const code=String(e).replace(/^Error: /,'');error=timedOut?(job.kind==='stage1_extract'?'stage1_timeout':job.kind==='stage2_analyze'?'stage2_timeout':'model_timeout'):job.kind==='stage2_analyze'&&['token_budget_exhausted','turn_budget_exceeded','tool_budget_exceeded','model_usage_unavailable','structured_submission_missing'].includes(code)?code:classifyError(e);}
    finally{clearTimeout(timer);clearInterval(heartbeat);await drain();activeAbort=undefined;}
    if(cancelled){state='cancelled';error='cancelled_by_user';}
    if(stopping){state='failed';error='worker_interrupted';}
    if(!ownershipLost) await post(`/internal/jobs/${job.id}/finish`,{...identity,state,result:state==='completed'?result:null,error});
    console.log(JSON.stringify({job_id:job.id,state,error}));
  }catch(e){console.error('worker_connection_error');await sleep(2000);}
}
