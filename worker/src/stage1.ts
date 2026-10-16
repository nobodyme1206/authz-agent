import path from 'node:path';
import { buildIndex } from './java-index.ts';
import { extractApis, EXTRACTOR_VERSION, type ApiEntry } from './spring.ts';
import { enrichApi, type Usage } from './enrich.ts';
import { classifyError } from './files.ts';
import type { ModelConfig } from './probe.ts';
export type StageJob={id:string;snapshot_id:string;source_revision:string;kind:string;options:{include_paths?:string[];enrich?:boolean;base_run_id?:string}};
export type StageLimits={apis:number;turns:number;tools:number;apiTimeout:number;tokens:number};
export async function runStage1(job:StageJob,config:ModelConfig,signal:AbortSignal,limits:StageLimits,post:(route:string,body:Record<string,unknown>)=>Promise<any>,emit:(type:string,data:Record<string,unknown>)=>void){
 const root=path.join(process.env.SNAPSHOT_ROOT||'/snapshots',job.snapshot_id);
 const runDir=path.join(process.env.RUN_ROOT||'/runs',job.id);const started=Date.now();
 const scan:any={extractor_version:EXTRACTOR_VERSION,phase:'indexing',limits:{...limits},include_paths:job.options.include_paths||[],index_complete:false,files:[],diagnostics:[],stats:{},usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},enrichment:{attempted:0,accepted_fields:0,skipped:0}};
 async function checkpoint(entries:ApiEntry[]=[],includeScan=true){
  scan.elapsed_seconds=Math.round((Date.now()-started)/10)/100;
  const base=`/internal/jobs/${job.id}/stage1/checkpoints`;
  let batch:ApiEntry[]=[],size=0;
  for(const entry of entries){const bytes=Buffer.byteLength(JSON.stringify(entry));if(batch.length&&(batch.length>=40||size+bytes>1500000)){await post(base,{entries:batch});batch=[];size=0;}batch.push(entry);size+=bytes;}
  await post(base,{entries:batch,...(includeScan?{scan}: {})});
 }
 const index=await buildIndex(root,job.options.include_paths||[],signal,async files=>{scan.files=files;scan.stats.files_processed=files.length;await checkpoint();});
 scan.files=index.files;scan.diagnostics=index.diagnostics;
 scan.phase='extracting';scan.stats={files_processed:index.files.length,classes:index.classes.length};await checkpoint();
 const entries=extractApis(index,job.source_revision,job.options.include_paths||[]);
 const prior:ApiEntry[]=job.options.base_run_id?await post(`/internal/jobs/${job.id}/stage1/base`,{}):[];
 const previous=new Map(prior.map(e=>[e.api.api_id,e]));
 for(let i=0;i<entries.length;i++)if(previous.has(entries[i].api.api_id))entries[i]=previous.get(entries[i].api.api_id)!;
 const groups=new Map<string,ApiEntry[]>();for(const e of entries){const key=e.detail.controller_file;groups.set(key,[...groups.get(key)||[],e]);}
 let saved=0;
 for(const group of groups.values()){
  if(signal.aborted)throw new Error('aborted');
  saved+=group.length;scan.stats.apis_saved=saved;await checkpoint(group);
 }
 scan.index_complete=true;scan.phase='enriching';scan.diagnostics=index.diagnostics;
 scan.stats.apis=entries.length;await checkpoint();
 let stopReason='';
 if(job.options.enrich===false)stopReason='disabled';
 else if(!config.apiKey||!config.modelId||!config.baseUrl)stopReason='model_not_configured';
 let usageKnown=true;
 const candidates=entries.filter(e=>e.api.unresolved.length);
 for(const entry of candidates){
  if(signal.aborted)throw new Error('aborted');
  if(scan.enrichment.attempted>=limits.apis)stopReason=stopReason||'api_budget_exhausted';
  if(scan.usage.totalTokens>=limits.tokens)stopReason=stopReason||'token_budget_exhausted';
  if(!usageKnown)stopReason=stopReason||'model_usage_unavailable';
  if(stopReason){entry.detail.enrichment_status='skipped';entry.detail.enrichment_skip_reason=stopReason;scan.enrichment.skipped++;await checkpoint([entry],false);continue;}
  delete entry.detail.enrichment_skip_reason;delete entry.detail.enrichment_error;
  const abort=new AbortController();const onAbort=()=>abort.abort();signal.addEventListener('abort',onAbort,{once:true});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;abort.abort();},limits.apiTimeout*1000);
  scan.enrichment.attempted++;emit('api_enrichment_started',{api_id:entry.api.api_id});
  try{
   const out=await enrichApi(root,runDir,entry,index,config,abort.signal,(type,data)=>{
    if(type==='api_model_usage'){
     const usage=data.usage as Usage;
     for(const key of Object.keys(scan.usage))scan.usage[key]+=usage[key as keyof Usage]||0;
     if(!data.usage_available)usageKnown=false;
    }
    emit(type,data);
   },{turns:limits.turns,tools:limits.tools,tokens:Math.max(1,limits.tokens-scan.usage.totalTokens)});
   Object.assign(entry,out.entry);scan.enrichment.accepted_fields+=Number(entry.detail.enrichment_accepted||0);
  }catch(error){
   const code=timedOut?'model_timeout':classifyError(error);
   entry.detail.enrichment_status='failed';entry.detail.enrichment_error=code;
   if(['model_authentication_failed','model_interface_incompatible','model_rate_limited'].includes(code))stopReason=code;
   emit('api_enrichment_failed',{api_id:entry.api.api_id,code});
  }finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  await checkpoint([entry]);
 }
 scan.phase='finished';scan.stats.fields=entries.reduce((n,e)=>n+e.api.request_fields.length,0);
 scan.stats.unresolved_apis=entries.filter(e=>e.api.unresolved.length).length;
 scan.enrichment.stop_reason=stopReason||null;await checkpoint();
 return {kind:'stage1_extract'};
}
