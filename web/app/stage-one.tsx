'use client';
import {useCallback,useEffect,useState} from 'react';
type Evidence={file:string;start_line:number;end_line:number};
type Field={name:string;location:string;type:string|null;note?:string;evidence?:Evidence[]};
type Api={api_id:string;method:string;path:string;file:string;line:number;request_fields:Field[];unresolved:string[]};
type Run={id:string;snapshot_id:string;kind:string;state:string;error:string|null;options:{include_paths?:string[]};analysis?:{phase:string;index_complete:boolean;stats:Record<string,number>;elapsed_seconds:number;files:{file:string;status:string;reason?:string}[];diagnostics:string[];usage:Record<string,number>;enrichment:Record<string,unknown>}};
async function request<T>(path:string,body?:unknown):Promise<T>{
 const r=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json();if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:'请求失败');return data;
}
const phases:Record<string,string>={indexing:'建立源码索引',extracting:'提取路由与字段',enriching:'补全疑难输入',finished:'分析结束'};
const states:Record<string,string>={queued:'排队中',running:'执行中',cancel_requested:'正在取消',completed:'执行完成',failed:'执行失败',cancelled:'已取消'};
export default function StageOne({projectId,snapshotId}:{projectId:string;snapshotId:string}){
 const [runs,setRuns]=useState<Run[]>([]),[runId,setRunId]=useState(''),[run,setRun]=useState<Run|null>(null);
 const [paths,setPaths]=useState('jeecg-boot'),[enrich,setEnrich]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [q,setQ]=useState(''),[method,setMethod]=useState(''),[unresolved,setUnresolved]=useState(false),[page,setPage]=useState(1),[apis,setApis]=useState<Api[]>([]),[total,setTotal]=useState(0),[selected,setSelected]=useState<{api:Api;detail:Record<string,unknown>}|null>(null);
 const [events,setEvents]=useState<{id:string;type:string;data:unknown}[]>([]),[code,setCode]=useState<(Evidence&{content:string})|null>(null),[fileFilter,setFileFilter]=useState('');
 const loadRuns=useCallback(async()=>{const r=await request<Run[]>(`/jobs?project_id=${projectId}&kind=stage1_extract`);setRuns(r.filter(j=>j.kind==='stage1_extract'));},[projectId]);
 const load=useCallback(async()=>{
  await loadRuns();if(!runId)return;
  const [r,list]=await Promise.all([request<Run>(`/jobs/${runId}`),request<{items:Api[];total:number}>(`/jobs/${runId}/apis?${new URLSearchParams({q,method,page:String(page),limit:'30',...(unresolved?{unresolved:'true'}:{})})}`)]);
  setRun(r);setApis(list.items);setTotal(list.total);
 },[loadRuns,runId,q,method,page,unresolved]);
 useEffect(()=>{setRunId('');setRun(null);setSelected(null);setCode(null);},[projectId]);
 useEffect(()=>{const refresh=()=>void load().catch(e=>setError(e.message));refresh();const timer=setInterval(refresh,3000);return()=>clearInterval(timer);},[load]);
 useEffect(()=>{
  if(!runId)return;setEvents([]);const sse=new EventSource(`/api/jobs/${runId}/events`);
  sse.addEventListener('execution',e=>{const ev=e as MessageEvent;setEvents(prev=>prev.some(x=>x.id===ev.lastEventId)?prev:[...prev,{id:ev.lastEventId,...JSON.parse(ev.data)}].slice(-80));const type=JSON.parse(ev.data).type;if(['completed','failed','cancelled','interrupted'].includes(type)){sse.close();void load().catch(e=>setError(e.message));}});
  return()=>sse.close();
 },[runId]); // A new EventSource is created only when the chosen task changes.
 async function start(base?:Run){
  setBusy(true);setError('');try{
   const r=await request<Run>('/jobs',{kind:'stage1_extract',snapshot_id:base?.snapshot_id||snapshotId,options:{include_paths:base?.options.include_paths||paths.split(',').map(x=>x.trim()).filter(Boolean),enrich:base?true:enrich,...(base?{base_run_id:base.id}:{})}});
   setRunId(r.id);setRun(r);setPage(1);setSelected(null);setCode(null);await loadRuns();
  }catch(e){setError(String(e instanceof Error?e.message:e));}finally{setBusy(false);}
 }
 async function showEvidence(e:Evidence){
  if(!run)return;try{const data=await request<Evidence&{content:string}>(`/snapshots/${run.snapshot_id}/evidence?${new URLSearchParams({file:e.file,start_line:String(e.start_line),end_line:String(e.end_line)})}`);setCode(data);}catch(e){setError(e instanceof Error?e.message:String(e));}
 }
 const terminal=run&&['completed','failed','cancelled'].includes(run.state);
 const analysis=run?.analysis;
 return <div className="stage-one">
  {error&&<div className="alert" role="alert">{error}<button onClick={()=>setError('')}>关闭</button></div>}
  <section className="panel"><div className="panel-heading"><div><h2>Stage 1 · API 与请求字段提取</h2><p className="muted">固定源码版本，先程序解析，再按预算补全疑难输入。此阶段不判断授权漏洞。</p></div><span className="badge green">Spring MVC · v0.4</span></div>
   <form onSubmit={e=>{e.preventDefault();void start();}}><label>扫描目录（相对快照，逗号分隔；留空扫描全部后端）<input value={paths} onChange={e=>setPaths(e.target.value)} placeholder="jeecg-boot"/></label><label className="check-label"><input type="checkbox" checked={enrich} onChange={e=>setEnrich(e.target.checked)}/>Pi 有界自动补全</label><button className="primary" disabled={!snapshotId||busy}>开始 Stage 1</button></form>
   {!snapshotId&&<p className="muted">请先在概览中创建或选择源码快照。</p>}
   <p className="muted">默认最多补全 20 个 API、累计 100,000 Token，每个 API 最长 120 秒。缺少模型配置时仍保留程序提取结果。</p>
  </section>
  <section className="panel"><label>分析任务<select value={runId} onChange={e=>{setRunId(e.target.value);setPage(1);setSelected(null);setCode(null);}}><option value="">选择已有任务</option>{runs.map(r=><option key={r.id} value={r.id}>{r.id} · {states[r.state]||r.state}</option>)}</select></label></section>
  {run&&<>
   <section className="panel"><div className="panel-heading"><div><h2>{states[run.state]||run.state} · {phases[analysis?.phase||'']||'等待领取'}</h2><p className="muted monospace">{run.id} · {run.snapshot_id}</p></div><div className="actions">{!terminal&&<button onClick={()=>void request(`/jobs/${run.id}/cancel`,{}).then(()=>load()).catch(e=>setError(e.message))}>取消</button>}{terminal&&<button onClick={()=>void start(run)} disabled={busy}>继续补全未解析项</button>}<a className="button-link" href={`/api/jobs/${run.id}/result`} download={`stage1-${run.id}.json`}>下载阶段结果</a></div></div>
    {run.error&&<p className="alert">{run.error}；已校验的检查点会保留。</p>}
    <div className="stage-metrics">{[['已处理文件',analysis?.stats.files_processed],['API',analysis?.stats.apis||analysis?.stats.apis_saved],['字段',analysis?.stats.fields],['待核查 API',analysis?.stats.unresolved_apis]].map(([label,value])=><div key={String(label)}><span>{label}</span><strong>{value??'—'}</strong></div>)}</div>
    <p className="muted">已用时 {analysis?.elapsed_seconds??0} 秒 · 自动补全尝试 {String(analysis?.enrichment.attempted??0)} 个 API · 采纳字段增量 {String(analysis?.enrichment.accepted_fields??0)} · 跳过 {String(analysis?.enrichment.skipped??0)} · 停止原因 {String(analysis?.enrichment.stop_reason||'无')}</p>
    <p className="muted monospace">模型用量：{JSON.stringify(analysis?.usage||{})}</p><div className="note">任务“执行完成”表示流程结束；如仍有未解析内容，下载结果中的阶段状态为 partial。API 数量表示源码声明，不表示当前部署全部启用。</div>
   </section>
   <section className="panel"><h2>API 清单</h2><form onSubmit={e=>e.preventDefault()}><input aria-label="搜索API" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="路径或入口文件"/><select aria-label="HTTP方法" value={method} onChange={e=>{setMethod(e.target.value);setPage(1);}}><option value="">全部方法</option>{['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE','ANY'].map(m=><option key={m}>{m}</option>)}</select><label className="check-label"><input type="checkbox" checked={unresolved} onChange={e=>{setUnresolved(e.target.checked);setPage(1);}}/>只看未解析项</label></form>
    <div className="api-table"><table><thead><tr><th>方法 / 路径</th><th>入口</th><th>字段</th><th>待核查</th></tr></thead><tbody>{apis.map(a=><tr key={a.api_id}><td><button onClick={()=>void request<{api:Api;detail:Record<string,unknown>}>(`/jobs/${run.id}/apis/${a.api_id}`).then(setSelected).catch(e=>setError(e.message))}><span className="badge">{a.method}</span> {a.path}</button></td><td title={a.file}>{a.file.split('/').at(-1)}:{a.line}</td><td>{a.request_fields.length}</td><td>{a.unresolved.length}</td></tr>)}</tbody></table></div><div className="pagination"><span>共 {total} 条 · 第 {page} 页</span><button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</button><button disabled={page*30>=total} onClick={()=>setPage(page+1)}>下一页</button></div>
   </section>
   {selected&&<section className="panel"><div className="panel-heading"><h2>{selected.api.method} {selected.api.path}</h2><button onClick={()=>void showEvidence({file:selected.api.file,start_line:selected.api.line,end_line:selected.api.line})}>查看入口源码</button></div><p className="muted monospace">{selected.api.file}:{selected.api.line}</p><p className="muted">{String(selected.detail.handler||'')} · 补全状态 {String(selected.detail.enrichment_status||'')}</p><p className="muted">路由条件：{JSON.stringify(selected.detail.conditions||{})}</p>
    <div className="api-table"><table><thead><tr><th>位置 / 字段</th><th>类型</th><th>说明与证据</th></tr></thead><tbody>{selected.api.request_fields.map(f=><tr key={f.location+':'+f.name}><td>{f.location}:{f.name}</td><td>{f.type??'未知'}</td><td>{f.note&&<p>{f.note}</p>}{f.evidence?.map((e,i)=><button key={i} title={e.file} onClick={()=>void showEvidence(e)}>{e.file.split('/').at(-1)}:{e.start_line}—{e.end_line}</button>)}</td></tr>)}</tbody></table></div>
    {!!selected.api.unresolved.length&&<div className="note"><strong>未解析问题</strong><ul>{selected.api.unresolved.map((s,i)=><li key={i}>{s}</li>)}</ul></div>}
   </section>}
   {code&&<section className="panel"><div className="panel-heading"><h2>只读源码证据</h2><button onClick={()=>setCode(null)}>收起</button></div><p className="muted monospace">{code.file}:{code.start_line}—{code.end_line}</p><pre className="evidence-code">{code.content.split('\n').map((line,i)=><div key={i}><span>{code.start_line+i}</span> {line||' '}</div>)}</pre></section>}
   <section className="panel"><details><summary>扫描文件与诊断（{analysis?.files.length||0} 个文件）</summary><input aria-label="筛选扫描文件" value={fileFilter} onChange={e=>setFileFilter(e.target.value)} placeholder="按文件路径筛选"/><div className="scan-ledger">{analysis?.files.filter(f=>f.file.includes(fileFilter)).map(f=><p key={f.file}><span className={'badge '+(f.status==='failed'?'red':'green')}>{f.status}</span> {f.file} {f.reason||''}</p>)}</div><pre>{JSON.stringify(analysis?.diagnostics||[],null,2)}</pre></details></section>
   <section className="panel"><details><summary>最近执行事件</summary><div className="event-list">{events.map(e=><div key={e.id}><span>#{e.id}</span><strong>{e.type}</strong><small>{JSON.stringify(e.data)}</small></div>)}</div></details></section>
  </>}
 </div>;
}
