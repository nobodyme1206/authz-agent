import path from 'node:path';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {SaxesParser} from 'saxes';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {bare,argumentsOf,ev,first,nodes,text,tokens,type JavaClass,type JavaIndex,type Method,type Evidence,type Token} from './java-index.ts';
import {calls,constant,type ApiEntry} from './spring.ts';
import {safePath} from './files.ts';

export const ANALYZER_VERSION='authz-java-1.1.12';
export type SqlStatement={namespace:string;id:string;kind:string;evidence:Evidence;includes:string[];dynamic:string[]};
export type NavNode={symbol:string;file:string;start_line:number;end_line:number;depth:number;parameters:{name:string;type:string}[]};
export type Edge={from:string;call:string;line:number;arguments:string[];status:string;targets:string[];owner_type?:string};
export type Candidate={kind:string;description:string;evidence:Evidence;inactive?:boolean;resource?:string;action?:string;call_start?:number};
export type Navigation={entry:Method;nodes:NavNode[];edges:Edge[];candidates:Candidate[];disabled:Evidence[];unresolved:string[];globals:{symbol:string;evidence:Evidence}[];controls:{symbol:string;value:string;evidence:Evidence}[]};
export type BackendIndex=JavaIndex&{sql:SqlStatement[];artifactDiagnostics:string[]};
const crud=new Set(['selectById','selectBatchIds','selectList','selectOne','selectCount','selectPage','getById','getOne','list','page','count','insert','update','updateById','delete','deleteById','deleteBatchIds','save','saveBatch','saveOrUpdate','saveOrUpdateBatch','updateBatchById','remove','removeById','removeByIds','removeBatchByIds']);
const utilityReceivers=new Set(['log','logger','System','String','Integer','Long','Boolean','Arrays','Collections','Collectors','Objects','Math','UUID','Date','oConvertUtils','StringUtils','CollectionUtils','CollectionUtil','ObjectUtil','RandomUtil','Assert','Result']);
const scalarMethods=new Set(['equals','equalsIgnoreCase','isEmpty','isNotEmpty','isBlank','isNotBlank','split','trim','toString','valueOf','size','isPresent','contains','containsKey','containsValue','add','addAll','put','remove','get','stream','collect','map','filter','distinct','flatMap','forEach','iterator','hasNext','next','substring','length','charAt','replace','replaceAll','format','getInt','parseInt']);
function key(m:Method){return m.owner.fqn+'.'+m.signature;}
function isWithin(e:Evidence,range:Evidence){return e.file===range.file&&e.start_line>=range.start_line&&e.end_line<=range.end_line;}
export function parseMapper(source:string,file:string):SqlStatement[]{
 const result:SqlStatement[]=[];let namespace='';let active:SqlStatement|undefined;let level=0;let activeLevel=0;let tagStart=1;
 const parser=new SaxesParser({xmlns:false,position:true});
 parser.on('error',e=>{throw e;});
 // Saxes does not fetch external DTDs. Reject internal subsets/entity declarations explicitly.
 parser.on('doctype',value=>{if(value.includes('[')||/<!ENTITY/i.test(value))throw new Error('xml_entities_forbidden');});
 parser.on('opentagstart',()=>{tagStart=parser.line;});
 parser.on('opentag',tag=>{
  level++;
  const attr=(name:string)=>String(tag.attributes[name]||'');
  if(tag.name==='mapper')namespace=attr('namespace');
  if(namespace&&['select','insert','update','delete','sql'].includes(tag.name)&&!active){
   active={namespace,id:attr('id'),kind:tag.name,evidence:{file,start_line:tagStart,end_line:parser.line},includes:[],dynamic:[]};activeLevel=level;
  }else if(active){
   if(tag.name==='include')active.includes.push(attr('refid'));
   if(['if','choose','when','otherwise','foreach','where','trim','set','bind'].includes(tag.name))active.dynamic.push(tag.name+':'+(attr('test')||attr('collection')||attr('name')));
  }
 });
 parser.on('closetag',()=>{if(active&&level===activeLevel){active.evidence.end_line=parser.line;result.push(active);active=undefined;}level--;});
 parser.write(source).close();return result;
}
export async function addBackendArtifacts(root:string,index:JavaIndex,signal:AbortSignal):Promise<BackendIndex>{
 const sql:SqlStatement[]=[];const artifactDiagnostics:string[]=[];
 async function walk(dir:string){
  for(const item of (await readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(signal.aborted)throw new Error('aborted');
   if(item.isSymbolicLink())continue;
   const file=path.posix.join(dir,item.name);
   if(item.isDirectory()){if(!['.git','node_modules','target','build','dist','.idea','.next'].includes(item.name))await walk(file);}
   else if(item.isFile()&&((('/'+file).includes('/src/main/')&&/\.(xml|ya?ml|properties)$/.test(file))||item.name==='pom.xml')){
    try{
     const safe=await safePath(root,file);if((await lstat(safe)).size>8*1024*1024)throw new Error('artifact_too_large');
     const source=new TextDecoder('utf8',{fatal:true}).decode(await readFile(safe));index.sources.set(file,source);
     if(file.endsWith('.xml')&&source.includes('<mapper')){if(file.includes('/code-template'))artifactDiagnostics.push(file+': code_template_not_runtime_mapper');else sql.push(...parseMapper(source,file));}
    }catch{artifactDiagnostics.push(file+': backend_artifact_parse_failed');}
    await yieldLoop();
   }
  }
 }
 await walk('');
 for(const c of index.classes)for(const m of c.methods)for(const a of m.annotations){
  if(['Select','Insert','Update','Delete','SelectProvider','InsertProvider','UpdateProvider','DeleteProvider'].includes(a.name))sql.push({namespace:c.fqn,id:m.name,kind:a.name.toLowerCase(),evidence:ev(c,a.node),includes:[],dynamic:a.name.endsWith('Provider')?['provider_source_requires_review']:['java_sql_annotation']});
 }
 return Object.assign(index,{sql,artifactDiagnostics});
}
function parents(c:JavaClass,index:JavaIndex,seen=new Set<string>()):JavaClass[]{
 if(seen.has(c.fqn))return [];seen.add(c.fqn);
 return c.parents.flatMap(p=>{const found=index.resolve(p,c);return found?[found,...parents(found,index,seen)]:[];});
}
function implementing(c:JavaClass,index:JavaIndex){return index.classes.filter(x=>x!==c&&!x.modifiers.includes('abstract')&&parents(x,index).some(p=>p.fqn===c.fqn));}
function methodsFor(c:JavaClass,name:string,index:JavaIndex){return [c,...parents(c,index)].flatMap(x=>x.methods.filter(m=>m.name===name));}
function scalarType(ts:Token[],locals:Map<string,string>):string|undefined{
 const raw=ts.map(t=>t.image).join('');
 if(locals.has(raw))return locals.get(raw);
 if(/^"/.test(raw))return 'String';if(/^\d+$/.test(raw))return 'int';if(['true','false'].includes(raw))return 'boolean';
 return undefined;
}
function equivalent(a:string,b:string){const normal=(s:string)=>({Integer:'int',Long:'long',Boolean:'boolean',Double:'double'}[bare(s)]||bare(s));return normal(a)===normal(b);}
function localTypes(m:Method){
 const result=new Map<string,string>(m.params.map(p=>[p.name,p.type]));
 for(const c of [m.owner])for(const f of c.fields)result.set(f.name,f.type);
 for(const n of nodes(m.node,'localVariableDeclaration')){
  const type=text(first(n,'unannType'))||text(first(n,'localVariableType'));
  for(const v of nodes(n,'variableDeclarator')){const id=text(first(v,'variableDeclaratorId'));if(id&&type)result.set(id,type);}
 }
 return result;
}
function entity(c:JavaClass,index:JavaIndex):string{
 for(const t of c.parents){const args=argumentsOf(t);if(['ServiceImpl'].includes(bare(t))&&args[1])return args[1];if(['IService','BaseMapper'].includes(bare(t))&&args[0])return args[0];}
 for(const p of parents(c,index)){const found=entityDirect(p);if(found)return found;}
 return c.name;
}
function entityDirect(c:JavaClass){for(const p of c.parents){const a=argumentsOf(p);if(bare(p)==='ServiceImpl'&&a[1])return a[1];if(['IService','BaseMapper'].includes(bare(p))&&a[0])return a[0];}return '';}
function tableOf(type:string,owner:JavaClass,index:JavaIndex){
 const c=index.resolve(type,owner);const ann=c?.annotations.find(a=>a.name==='TableName');
 return ann?constant(ann.values.value||[],c!,index)||type:type;
}
// A three-valued evaluator, never eval/execute expressions from the source repository.
export function booleanCondition(ts:Token[],lookup:(name:string)=>boolean|undefined):boolean|undefined{
 let i=0;
 function atom():boolean|undefined{
  if(ts[i]?.image==='!'){i++;const v=atom();return v===undefined?undefined:!v;}
  if(ts[i]?.image==='('){i++;const v=or();if(ts[i]?.image!==')')return undefined;i++;return v;}
  let name='',nested=0;while(i<ts.length){const t=ts[i].image;if(nested===0&&['&&','||',')'].includes(t))break;if(t==='(')nested++;if(t===')')nested--;name+=ts[i++].image;}
  return name==='true'?true:name==='false'?false:lookup(name);
 }
 function and():boolean|undefined{let a=atom();while(ts[i]?.image==='&&'){i++;const b=atom();a=a===false||b===false?false:a===true&&b===true?true:undefined;}return a;}
 function or():boolean|undefined{let a=and();while(ts[i]?.image==='||'){i++;const b=and();a=a===true||b===true?true:a===false&&b===false?false:undefined;}return a;}
 const out=or();return i===ts.length?out:undefined;
}
export function navigate(index:BackendIndex,input:ApiEntry,limits={depth:6,nodes:200}):Navigation{
 const controller=index.classes.find(c=>c.fqn===input.detail.identity[2]&&c.file===(input.detail.controller_file||input.detail.identity[1]));
 const target=[controller,...controller?parents(controller,index):[]].filter(Boolean).flatMap(c=>c!.methods).find(m=>m.signature===input.detail.identity[3]);
 if(!target)throw new Error('stage2_entry_not_found');
 const nav:Navigation={entry:target,nodes:[],edges:[],candidates:[],disabled:[],unresolved:[],globals:[],controls:[]};
 const seen=new Set<string>();const queued:{method:Method;depth:number}[]=[{method:target,depth:0}];
 for(const c of index.classes){
  if(/ShiroConfig|ShiroRealm|JwtFilter|PermissionDataAspect|MybatisPlusSaasConfig|MybatisInterceptor|QueryGenerator|TenantContext|JeecgDataAutorUtils/.test(c.name))nav.globals.push({symbol:c.fqn,evidence:{file:c.file,start_line:c.line,end_line:c.line}});
  for(const f of c.fields)if(f.modifiers.includes('static')&&f.modifiers.includes('final')&&['Boolean','boolean'].includes(bare(f.type))){const value=constant(f.initializer,c,index);if(['true','false'].includes(value||''))nav.controls.push({symbol:c.fqn+'.'+f.name,value:value!,evidence:ev(c,f.node)});}
 }
 function booleanLookup(name:string,owner:JavaClass){const short=name.split('.').at(-1);const matches=nav.controls.filter(c=>c.symbol===name||c.symbol===owner.fqn+'.'+name||c.symbol.endsWith('.'+name)&&name.includes('.'));return matches.length===1?matches[0].value==='true':undefined;}
 function inspectBranches(m:Method){
   for(const node of nodes(m.node,'ifStatement')){
   const all=tokens(node);const open=all.findIndex(t=>t.image==='(');let d=1,end=open+1;
   for(;end<all.length&&d;end++){if(all[end].image==='(')d++;if(all[end].image===')')d--;}
   if(open<0||d)continue;
   const condition=all.slice(open+1,end-1);let bodyEnd=end;
   if(all[end]?.image==='{'){let braces=1;for(bodyEnd=end+1;bodyEnd<all.length&&braces;bodyEnd++){if(all[bodyEnd].image==='{')braces++;if(all[bodyEnd].image==='}')braces--;}}
   else{while(bodyEnd<all.length&&all[bodyEnd].image!==';')bodyEnd++;bodyEnd++;}
   const evidence={file:m.owner.file,start_line:all[0].startLine,end_line:all[Math.min(bodyEnd-1,all.length-1)].endLine};
   const inactive=booleanCondition(condition,n=>booleanLookup(n,m.owner))===false;
   nav.candidates.push({kind:'branch',description:condition.map(t=>t.image).join(' '),evidence,inactive});if(inactive)nav.disabled.push(Object.assign(evidence,{start_offset:all[0].startOffset,end_offset:all[Math.min(bodyEnd-1,all.length-1)].endOffset}));
  }
 }
 for(const c of index.classes.filter(c=>nav.globals.some(g=>g.symbol===c.fqn)))for(const m of c.methods)inspectBranches(m);
 while(queued.length){
  const {method:m,depth}=queued.shift()!;if(seen.has(key(m)))continue;
  if(nav.nodes.length>=limits.nodes){nav.unresolved.push('调用节点超过上限 '+limits.nodes);break;}
  seen.add(key(m));nav.nodes.push({symbol:key(m),file:m.owner.file,start_line:tokens(m.node)[0]?.startLine||m.line,end_line:m.end,depth,parameters:m.params.map(p=>({name:p.name,type:p.type}))});
  inspectBranches(m);
  for(const a of [...m.owner.annotations,...m.annotations])if(/Requires|PermissionData|InterceptorIgnore|Transactional|PreAuthorize/.test(a.name))nav.candidates.push({kind:'annotation',description:text(a.node),evidence:ev(m.owner,a.node)});
  const locals=localTypes(m);
  if(!locals.has('baseMapper'))for(const c of [m.owner,...parents(m.owner,index)]){const generic=c.parents.find(p=>bare(p)==='ServiceImpl');if(generic&&argumentsOf(generic)[0]){locals.set('baseMapper',argumentsOf(generic)[0]);break;}}
  for(const p of parents(m.owner,index))for(const f of p.fields)if(!locals.has(f.name))locals.set(f.name,f.type);
  for(const call of calls(m.body)){
   const e={file:m.owner.file,start_line:call.line,end_line:call.line};
   if(nav.disabled.some(r=>r.file===m.owner.file&&call.start>=(r as any).start_offset&&call.end<=(r as any).end_offset))continue;
   const raw=call.args.map(a=>a.map(t=>t.image).join(''));
   let owner:JavaClass|undefined;
   if(!call.receiver||call.receiver==='this'||call.receiver==='super')owner=call.receiver==='super'?parents(m.owner,index)[0]:m.owner;
   else owner=index.resolve(locals.get(call.receiver)||call.receiver,m.owner);
   let targets:Method[]=[];let status='unresolved';
   const owners=owner?[owner,...implementing(owner,index)]:[];
   if(owners.length){
    let concrete=owners.filter(c=>methodsFor(c,call.name,index).some(t=>t.body.length>=2));
    const injected=m.owner.fields.find(f=>f.name===call.receiver);
    const qualifier=injected?.annotations.find(a=>a.name==='Qualifier');
    if(qualifier){const name=constant(qualifier.values.value||[],m.owner,index);concrete=concrete.filter(c=>c.name[0].toLowerCase()+c.name.slice(1)===name||c.annotations.some(a=>a.values.value&&constant(a.values.value,c,index)===name));}
    if(concrete.length>1){const primary=concrete.filter(c=>c.annotations.some(a=>a.name==='Primary'));if(primary.length===1)concrete=primary;}
    const selected=concrete.length?concrete:qualifier?[]:owners;
    targets=selected.flatMap(c=>methodsFor(c,call.name,index)).filter(t=>t.params.length===call.args.length);
    targets=targets.filter((t,i,a)=>a.findIndex(x=>key(x)===key(t))===i);
    if(targets.length>1){const typed=targets.filter(t=>t.params.every((p,i)=>{const type=scalarType(call.args[i],locals);return !type||equivalent(p.type,type);}));if(typed.length)targets=typed;}
    const concreteMethods=targets.filter(t=>t.body.length>=2);if(concreteMethods.length)targets=concreteMethods;
    if(targets.length===1)status='resolved';else if(targets.length>1)status='ambiguous';
   }
   const sql=index.sql.filter(s=>owner&&[owner,...parents(owner,index)].some(c=>c.fqn===s.namespace)&&s.id===call.name);
   if(sql.length===1){status='sql';nav.candidates.push({kind:'sql',description:sql[0].kind+' '+sql[0].namespace+'.'+sql[0].id,evidence:sql[0].evidence});
    if(['insert','update','delete'].includes(sql[0].kind)){
     const resource=tableOf(entity(owner!,index),owner!,index);
     nav.candidates.push({kind:'operation',resource,action:sql[0].kind,call_start:call.start,description:`源码分支内调用 ${call.receiver||'this'}.${call.name}(${raw.join(', ')})，Mapper ${sql[0].namespace}.${sql[0].id} ${sql[0].kind}，资源候选 ${resource}；SQL 及执行条件待核查`,evidence:e});
    }
   }
   else if(crud.has(call.name)&&((owner&&/Mapper|Service/.test(owner.name))||call.receiver==='baseMapper'||call.receiver==='this'||!call.receiver)){
    status=targets.length===1&&targets[0].body.length>=2?'resolved':'framework_crud';
    const resource=tableOf(entity(owner||m.owner,index),owner||m.owner,index);
    nav.candidates.push({kind:'operation',resource,action:call.name,call_start:call.start,description:`源码分支内调用 ${call.receiver||'this'}.${call.name}(${raw.join(', ')})，资源候选 ${resource}；执行条件及字段关系待语义核查`,evidence:e});
   }
   if((['DateUtils','SqlInjectionUtil'].includes(call.receiver)||call.receiver==='CommonUtils'&&call.name==='getDatabaseType'||call.receiver==='SpringContextUtils'&&['getHttpServletRequest','getHttpServletResponse','getApplicationContext'].includes(call.name)))status='framework_value_boundary';
   if((status==='unresolved'||status==='ambiguous')&&(utilityReceivers.has(call.receiver)||scalarMethods.has(call.name)||/^(get|set|is)[A-Z]/.test(call.name)&&owner?.fields.some(f=>f.name.toLowerCase()===call.name.replace(/^(get|set|is)/,'').toLowerCase())))status='value_operation';
   if(status==='unresolved'&&['SecurityUtils','TenantContext','JwtUtil','PasswordUtil','TokenUtils'].includes(call.receiver))status='identity_boundary';
   const rawType=locals.get(call.receiver)||call.receiver;
   const imported=m.owner.imports.find(x=>!x.endsWith('.*')&&x.split('.').at(-1)===bare(rawType));
   let receiverType=owner?.fqn||imported||rawType;
   const at=m.body.findIndex(t=>t.startOffset===call.start);
   // Narrow signature-backed chain: java.security.Principal.getName() returns String.
   // A custom object's getName/equals is deliberately not classified by name alone.
   if(call.receiver===')'&&call.name==='equals'&&m.body[at-3]?.image==='('&&m.body[at-4]?.image==='getName'&&m.body[at-5]?.image==='.'){
    const type=locals.get(m.body[at-6]?.image)||'';
    if(type==='java.security.Principal'||type==='Principal'&&m.owner.imports.includes('java.security.Principal')&&!index.resolve(type,m.owner))receiverType='java.lang.String';
   }
   if(m.body[at-1]?.image==='new'&&!index.resolve(call.name,m.owner)&&['SecurityException','RuntimeException','IllegalArgumentException','IllegalStateException'].includes(call.name))receiverType='java.lang.'+call.name;
   nav.edges.push({from:key(m),call:(call.receiver?call.receiver+'.':'')+call.name,line:call.line,arguments:raw,status,targets:targets.map(key),owner_type:receiverType});
   if(status==='resolved'){
    if(depth>=limits.depth)nav.unresolved.push('调用超过 '+limits.depth+' 层：'+key(m)+' -> '+call.name);
    else queued.push({method:targets[0],depth:depth+1});
   }else if(status==='ambiguous')nav.unresolved.push('调用实现不唯一：'+key(m)+':'+call.line+' '+call.name);
   // All opaque edges remain in the ledger. Pi must review auth-relevant ones, rather than a
   // blanket claim that every unanalysed logging/date/framework call is a missing authorizer.
  }
 }
 nav.unresolved=[...new Set(nav.unresolved)];return nav;
}
