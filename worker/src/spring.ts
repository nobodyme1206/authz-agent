import { createHash } from 'node:crypto';
import { annotation, argumentsOf, bare, ev, first, nodes, split, text, tokens, type Annotation, type Evidence, type JavaClass, type JavaIndex, type Method, type Token, type Variable } from './java-index.ts';

export const EXTRACTOR_VERSION='spring-java-1.0.5';
export type RequestField={name:string;location:'body'|'query'|'path'|'form'|'header';type:string|null;note?:string;evidence?:Evidence[]};
export type Api={api_id:string;method:string;path:string;file:string;line:number;request_fields:RequestField[];unresolved:string[]};
export type ApiEntry={api:Api;detail:{identity:string[];handler:string;controller_file:string;conditions:Record<string,string>;evidence_files:string[];enrichment_status:string;[key:string]:unknown}};
const mappings:Record<string,string>={RequestMapping:'ANY',GetMapping:'GET',PostMapping:'POST',PutMapping:'PUT',DeleteMapping:'DELETE',PatchMapping:'PATCH'};
function simple(type:string):string|null {
 const b=bare(type);
 if(b==='MultipartFile')return 'file';
 if(['String','CharSequence','char','Character','UUID','Date','LocalDate','LocalDateTime','Instant'].includes(b))return 'string';
 if(['int','Integer','long','Long','short','Short','byte','Byte','BigInteger'].includes(b))return 'integer';
 if(['float','Float','double','Double','BigDecimal','Number'].includes(b))return 'number';
 if(['boolean','Boolean'].includes(b))return 'boolean';
 return null;
}
const mapType=(t:string)=>['JSONObject','Map','HashMap','LinkedHashMap','ObjectNode','JsonNode'].includes(bare(t));
const collection=(t:string)=>t.endsWith('[]')||['List','Set','Collection','ArrayList','JSONArray'].includes(bare(t));
const servlet=(t:string)=>['HttpServletRequest','ServletRequest','MultipartHttpServletRequest'].includes(bare(t));
const ignored=(t:string)=>['HttpServletResponse','ServletResponse','BindingResult','Model','ModelMap','ModelAndView','Principal','Authentication','SessionStatus','HttpSession','Locale','Pageable','RedirectAttributes'].includes(bare(t));
export function constant(ts:Token[],owner:JavaClass,index:JavaIndex,seen=new Set<string>()):string|undefined{
 if(!ts.length)return undefined;
 if(ts.length===1&&['true','false'].includes(ts[0].image))return ts[0].image;
 if(ts[0].image==='('&&ts.at(-1)?.image===')')return constant(ts.slice(1,-1),owner,index,seen);
 const chunks=split(ts,'+');
 if(chunks.length>1){const parts=chunks.map(x=>constant(x,owner,index,new Set(seen)));return parts.every(x=>x!==undefined)?parts.join(''):undefined;}
 if(ts.length===1&&ts[0].image.startsWith('"')){try{return JSON.parse(ts[0].image);}catch{return undefined;}}
 const key=ts.map(t=>t.image).join('');
 if(seen.has(key)||seen.size>10)return undefined;seen.add(key);
 let cls=owner;let name=key;
 if(key.includes('.')){name=key.split('.').at(-1)!;const type=key.slice(0,-name.length-1);cls=index.resolve(type,owner)||index.classes.find(c=>c.fqn===type)||owner;}
 let field=cls.fields.find(f=>f.name===name&&f.modifiers.includes('static')&&f.modifiers.includes('final'));
 if(!field&&!key.includes('.'))for(const imported of owner.imports){
  const parent=imported.endsWith('.*')?imported.slice(0,-2):imported.split('.').slice(0,-1).join('.');
  const target=index.classes.find(c=>c.fqn===parent);
  const found=target?.fields.find(f=>f.name===name&&f.modifiers.includes('static')&&f.modifiers.includes('final'));
  if(found&&target){cls=target;field=found;break;}
 }
 return field?.initializer.length?constant(field.initializer,cls,index,seen):undefined;
}
function values(a:Annotation|undefined,key:string,owner:JavaClass,index:JavaIndex):{items:string[];unknown:boolean}{
 const ts=a?.values[key];if(!ts)return {items:[],unknown:false};
 const groups=ts[0]?.image==='{'?split(ts.slice(1,-1)): [ts];
 const v=groups.map(g=>constant(g,owner,index));
 return {items:v.filter(x=>x!==undefined) as string[],unknown:v.some(x=>x===undefined)};
}
function attribute(a:Annotation|undefined,key:string,owner:JavaClass,index:JavaIndex){return values(a,key,owner,index).items[0];}
function pathValues(a:Annotation|undefined,owner:JavaClass,index:JavaIndex){
 const value=values(a,a?.values.path?'path':'value',owner,index);
 if(!value.items.length&&!value.unknown)value.items=[''];return value;
}
function methods(a:Annotation|undefined){
 if(!a)return [];
 if(a.name!=='RequestMapping')return [mappings[a.name]];
 if(!a.values.method)return [];
 return split(a.values.method.filter(t=>!['{','}'].includes(t.image))).map(v=>v.map(t=>t.image).join('').split('.').at(-1)!).filter(x=>['GET','POST','PUT','DELETE','PATCH','OPTIONS','HEAD','TRACE'].includes(x));
}
function parentClasses(c:JavaClass,index:JavaIndex,seen=new Set<string>()):JavaClass[]{
 if(seen.has(c.fqn))return [];seen.add(c.fqn);
 return c.parents.flatMap(t=>{const p=index.resolve(t,c);return p?[p,...parentClasses(p,index,seen)]:[];});
}
function controllerMethods(cls:JavaClass,index:JavaIndex):Method[]{
 const result=[...cls.methods];
 for(const p of parentClasses(cls,index))for(const m of p.methods){
  const own=result.find(x=>x.signature===m.signature);
  if(!own)result.push(m);
  else if(!own.annotations.some(a=>a.name in mappings)&&m.annotations.some(a=>a.name in mappings)){
   const merged={...own,annotations:[...own.annotations,...m.annotations.filter(a=>a.name in mappings)],params:own.params.map((v,i)=>({...v,annotations:v.annotations.length?v.annotations:m.params[i]?.annotations||[]}))};
   result[result.indexOf(own)]=merged;
  }
 }
 return result;
}
function joinPath(a:string,b:string){const left=a.startsWith('/')?a:'/'+a;if(!b)return left||'/';return (a?left.replace(/\/$/,''):'')+(b.startsWith('/')?b:'/'+b);}
export function identify(identity:string[]){return 'api-'+createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24);}

export function extractApis(index:JavaIndex,revision:string,include:string[]=[]) :ApiEntry[]{
 const entries:ApiEntry[]=[];
 for(const cls of index.classes){
  if(include.length&&!include.some(p=>cls.file===p||cls.file.startsWith(p+'/')))continue;
  if(cls.modifiers.includes('abstract')||!cls.annotations.some(a=>['RestController','Controller'].includes(a.name)))continue;
  const classMapping=cls.annotations.find(a=>a.name in mappings)||parentClasses(cls,index).flatMap(c=>c.annotations).find(a=>a.name in mappings);
  const cp=pathValues(classMapping,cls,index);
  for(const method of controllerMethods(cls,index)){
   const mapping=method.annotations.find(a=>a.name in mappings);
   if(!mapping){if(method.annotations.some(a=>a.name.endsWith('Mapping')))index.diagnostics.push(cls.file+':'+method.line+': unsupported_mapping_annotation');continue;}
   const mp=pathValues(mapping,method.owner,index);
   if(cp.unknown||mp.unknown){index.diagnostics.push(cls.file+':'+method.line+': unresolved_route_expression');continue;}
   const mm=methods(mapping),cm=methods(classMapping);
   // Spring RequestMethodsRequestCondition.combine uses a union of declared methods.
   const effective=mm.length||cm.length?[...new Set([...cm,...mm])]:['ANY'];
   if(!effective.length){index.diagnostics.push(cls.file+':'+method.line+': conflicting_http_methods');continue;}
   const conditions:Record<string,string>={};
   for(const key of ['params','headers','consumes','produces']){
    const inherited=classMapping?.values[key]?.map(t=>t.image).join('');
    const local=mapping.values[key]?.map(t=>t.image).join('');
    if(inherited||local)conditions[key]=JSON.stringify({class:inherited||null,method:local||null});
   }
   for(const a of cp.items)for(const b of mp.items)for(const verb of effective){
    const route=joinPath(a,b);
    const identity=[revision,cls.file,cls.fqn,method.signature,route,verb,JSON.stringify(conditions)];
    const api:Api={api_id:identify(identity),method:verb,path:route,file:method.owner.file,line:method.line,request_fields:[],unresolved:[]};
    if(route.includes('${')||route.includes('#{'))api.unresolved.push('路由包含运行时配置占位符，保留源码表达式。');
    const evidenceFiles=new Set<string>([cls.file,method.owner.file]);
    extractFields(api,method,index,evidenceFiles);
    entries.push({api,detail:{identity,handler:cls.fqn+'.'+method.signature,controller_file:cls.file,conditions,evidence_files:[...evidenceFiles].sort(),enrichment_status:api.unresolved.length?'pending':'not_needed'}});
   }
  }
 }
 const seen=new Set<string>();return entries.filter(e=>{if(seen.has(e.api.api_id))return false;seen.add(e.api.api_id);return true;}).sort((a,b)=>a.api.file.localeCompare(b.api.file)||a.api.line-b.api.line||a.api.method.localeCompare(b.api.method)||a.api.path.localeCompare(b.api.path));
}

type Binding={locations:RequestField['location'][];prefix:string;type:string;scalar?:string};
export type Call={receiver:string;name:string;args:Token[][];line:number;start:number;end:number};
export function calls(ts:Token[]):Call[]{
 const result:Call[]=[];
 for(let i=0;i<ts.length-1;i++){
  if(ts[i+1]?.image!=='('||!/^[A-Za-z_$][\w$]*$/.test(ts[i].image)||['if','for','while','switch','catch','synchronized','new','return','throw'].includes(ts[i].image))continue;
  let d=1,j=i+2;for(;j<ts.length&&d;j++){if(ts[j].image==='(')d++;if(ts[j].image===')')d--;}
  if(d)continue;
  result.push({receiver:ts[i-1]?.image==='.'?ts[i-2]?.image:'',name:ts[i].image,args:ts[i+2]?.image===')'?[]:split(ts.slice(i+2,j-1)),line:ts[i].startLine,start:ts[i].startOffset,end:ts[j-1].endOffset});
 }
 return result;
}
export function extractFields(api:Api,entry:Method,index:JavaIndex,evidenceFiles:Set<string>){
 const fields=new Map<string,RequestField>();const unresolved=new Set(api.unresolved);
 function add(name:string,locations:Binding['locations'],type:string|null,e:Evidence,note?:string){
  if(!name)return;
  if(fields.size>=2000){unresolved.add('单个 API 字段超过 2000 项，剩余字段未展开');return;}
  evidenceFiles.add(e.file);
  for(const location of locations){
   const key=location+':'+name;const old=fields.get(key);
   if(old&&old.type&&type&&old.type!==type){unresolved.add('字段类型冲突：'+key);continue;}
   const merged=old||{name,location,type};
   if(!merged.type&&type)merged.type=type;
   if(note)merged.note=[...new Set([merged.note,note].filter(Boolean))].join('；');
   merged.evidence=[...merged.evidence||[],e].filter((x,i,a)=>a.findIndex(y=>JSON.stringify(x)===JSON.stringify(y))===i);
   fields.set(key,merged);
  }
 }
 const parameterLocations:Binding['locations']=api.method==='GET'||api.method==='HEAD'?['query']:['query','form'];
 function dto(type:string,prefix:string,locations:Binding['locations'],owner:JavaClass,e:Evidence,seen=new Set<string>(),depth=0){
  if(depth>6){unresolved.add('DTO 展开超过六层：'+prefix);return;}
  if(collection(type)){
   const item=type.endsWith('[]')?type.slice(0,-2):argumentsOf(type)[0];
   if(!item){unresolved.add('集合元素类型未知：'+prefix);if(prefix)add(prefix,locations,null,e);return;}
   dto(item,prefix+'[]',locations,owner,e,seen,depth+1);return;
  }
  const primitive=simple(type);
  if(primitive){add(prefix||'$',locations,primitive,e);return;}
  if(mapType(type)||['Object','T','?'].includes(bare(type))){if(prefix)add(prefix,locations,null,e,'动态对象，字段需根据实际读取恢复');unresolved.add('动态对象字段待核实：'+(prefix||'$'));return;}
  const target=index.resolve(type,owner);
  if(!target){if(prefix)add(prefix,locations,null,e);unresolved.add('无法解析 DTO 类型：'+type);return;}
  if(seen.has(target.fqn)){unresolved.add('DTO 循环引用：'+prefix);return;}
  const next=new Set(seen);next.add(target.fqn);evidenceFiles.add(target.file);
  const genericBindings=new Map(target.typeParams.map((p,i)=>[p,argumentsOf(type)[i]||p]));
  function expandClass(c:JavaClass,chain=new Set<string>()){
   if(chain.has(c.fqn))return;chain.add(c.fqn);
   for(const parentType of c.parents){const parent=index.resolve(parentType,c);if(parent)expandClass(parent,chain);else if(!['Object','Serializable','Comparable','Cloneable'].includes(bare(parentType)))unresolved.add('无法解析父类型：'+parentType);}
   for(const f of c.fields){
    if(f.modifiers.includes('static')||f.modifiers.includes('transient'))continue;
    const ignore=annotation(f.annotations,'JsonIgnore');
    if(ignore&&attribute(ignore,'value',c,index)!=='false')continue;
    const property=annotation(f.annotations,'JsonProperty');
    if(property?.values.access?.some(t=>t.image==='READ_ONLY'))continue;
    if(!f.name)continue;
    const lombok=c.annotations.some(a=>['Data','Setter'].includes(a.name));
    const setter=c.methods.some(m=>m.name==='set'+f.name[0].toUpperCase()+f.name.slice(1));
    if(f.modifiers.includes('private')&&!lombok&&!setter&&!property){unresolved.add('无法确认属性可绑定：'+c.name+'.'+f.name);continue;}
    const renamed=attribute(property,'value',c,index)||attribute(annotation(f.annotations,'JSONField'),'name',c,index)||f.name;
    if(annotation(f.annotations,'JSONField')?.values.deserialize?.some(t=>t.image==='false'))continue;
    const n=prefix?prefix+'.'+renamed:renamed;
    dto(genericBindings.get(f.type)||f.type,n,locations,c,ev(c,f.node),next,depth+1);
   }
  }
  expandClass(target);
 }
 const bindings=new Map<string,Binding>();
 for(const p of entry.params){
  const e=ev(entry.owner,p.node);const b=p.annotations;
  if(servlet(p.type)){bindings.set(p.name,{locations:parameterLocations,prefix:'',type:p.type});continue;}
  if(ignored(p.type)||b.some(a=>['AuthenticationPrincipal','SessionAttribute','CookieValue','RequestAttribute'].includes(a.name)))continue;
  const a=b.find(a=>['RequestBody','RequestParam','PathVariable','RequestHeader','RequestPart','ModelAttribute'].includes(a.name));
  if(mapType(p.type)&&!a){unresolved.add('未注解 Map 参数绑定语义待核实：'+p.name);continue;}
  const name=attribute(a,'name',entry.owner,index)||attribute(a,'value',entry.owner,index)||p.name;
  let locations:Binding['locations'];
  if(a?.name==='RequestBody')locations=['body'];
  else if(a?.name==='PathVariable')locations=['path'];
  else if(a?.name==='RequestHeader')locations=['header'];
  else if(a?.name==='RequestPart'||bare(p.type)==='MultipartFile'||argumentsOf(p.type).some(t=>bare(t)==='MultipartFile'))locations=['form'];
  else locations=parameterLocations;
  const primitive=simple(p.type);
  const isCollection=collection(p.type);
  const rawObject=a?.name==='RequestBody'||a?.name==='ModelAttribute'||(!primitive&&!a);
  const prefix=rawObject||mapType(p.type)?'':isCollection&&name.endsWith('[]')?name.slice(0,-2):name;
  const bind:Binding={locations,prefix,type:p.type};bindings.set(p.name,bind);
  if(primitive&&!rawObject){add(name,locations,primitive,e);bind.scalar=name;}
  else if(bare(p.type)==='MultipartFile')add(name,locations,'file',e);
  else if(mapType(p.type)){unresolved.add('动态对象字段待核实：'+p.name);}
  else if(isCollection||rawObject)dto(p.type,prefix,locations,entry.owner,e);
  else add(name,locations,null,e);
  const def=attribute(a,'defaultValue',entry.owner,index);
  if(def!==undefined)for(const f of fields.values())if(f.name===name)f.note='默认值：'+def;
 }
 function resolveCall(m:Method,c:Call,variables:Map<string,string>):Method|undefined{
  let target:JavaClass|undefined=m.owner;
  if(c.receiver&&c.receiver!=='this'&&c.receiver!=='super'){
   const type=variables.get(c.receiver)||m.owner.fields.find(f=>f.name===c.receiver)?.type||c.receiver;
   target=index.resolve(type,m.owner);
   if(target&&!target.methods.some(x=>x.name===c.name&&x.body.length>2)){
    const implementations=index.classes.filter(x=>x.parents.some(p=>bare(p)===target!.name)&&x.methods.some(y=>y.name===c.name&&y.body.length>2));
    if(implementations.length===1)target=implementations[0];
   }
  }
  if(!target)return undefined;
  const matches=[...target.methods,...parentClasses(target,index).flatMap(p=>p.methods)].filter(x=>x.name===c.name&&x.params.length===c.args.length&&x.body.length>2);
  return matches.length===1?matches[0]:undefined;
 }
 const visited=new Set<string>();
 function inspect(m:Method,incoming:Map<string,Binding>,depth:number){
  const key=m.owner.fqn+'.'+m.signature+JSON.stringify([...incoming]);if(visited.has(key))return;visited.add(key);evidenceFiles.add(m.owner.file);
  const vars=new Map<string,string>([...m.params.map(p=>[p.name,p.type] as [string,string]),...m.owner.fields.map(p=>[p.name,p.type] as [string,string])]);
  const current=new Map(incoming);
  for(const f of m.owner.fields)if(servlet(f.type))current.set(f.name,{locations:parameterLocations,prefix:'',type:f.type});
  const localDecls=nodes(first(m.node,'methodBody'),'localVariableDeclaration');
  const pending=calls(m.body);
  for(const declaration of localDecls){
   const type=text(first(declaration,'localVariableType'));
   for(const v of nodes(declaration.children.variableDeclaratorList?.[0],'variableDeclarator')){
    const name=text(first(v,'variableDeclaratorId'));vars.set(name,type);
    const init=tokens(first(v,'variableInitializer'));
    if(init.length===1&&current.has(init[0].image))current.set(name,{...current.get(init[0].image)!});
    else if(init[0]?.image==='('&&init.at(-2)?.image===')'&&current.has(init.at(-1)!.image))current.set(name,{...current.get(init.at(-1)!.image)!,type});
    const read=calls(init).find(c=>current.has(c.receiver));
    if(read){const binding=readCall(read,current.get(read.receiver)!,m,type);if(binding)current.set(name,binding);}
   }
  }
  for(const c of pending){
   const bound=current.get(c.receiver);
   if(bound)readCall(c,bound,m);
   const passed=new Map<string,Binding>();
   c.args.forEach((arg,i)=>{if(arg.length===1&&current.has(arg[0].image))passed.set(String(i),current.get(arg[0].image)!);});
   if(!passed.size)continue;
   const target=resolveCall(m,c,vars);
   if(target){
    if(depth>=2){if([...passed.values()].some(b=>mapType(b.type)||servlet(b.type)))unresolved.add('跨方法追踪超过两层：'+target.owner.name+'.'+target.name);continue;}
    const mapped=new Map<string,Binding>();for(const [i,b]of passed)mapped.set(target.params[Number(i)].name,b);
    inspect(target,mapped,depth+1);
   }else if([...passed.values()].some(b=>mapType(b.type)||servlet(b.type))){unresolved.add('输入对象进入未解析调用：'+(c.receiver?c.receiver+'.':'')+c.name);}
  }
 }
 const readNames:Record<string,string|null>={getString:'string',getIntValue:'integer',getInteger:'integer',getLong:'integer',getLongValue:'integer',getDouble:'number',getDoubleValue:'number',getFloat:'number',getBoolean:'boolean',getBooleanValue:'boolean',getJSONObject:null,getJSONArray:null,getObject:null,get:null,path:null};
 function readCall(c:Call,b:Binding,m:Method,assignedType?:string):Binding|undefined{
  const e:Evidence={file:m.owner.file,start_line:c.line,end_line:c.line};
  if(c.name==='split'&&b.scalar){
   if(constant(c.args[0]||[],m.owner,index)===',')add(b.scalar,b.locations,simple(b.type)||'string',e,'逗号分隔的集合编码');return undefined;
  }
  const servletRead=servlet(b.type)&&['getParameter','getParameterValues','getHeader','getHeaders','getFile','getFiles'].includes(c.name);
  if((mapType(b.type)&&Object.hasOwn(readNames,c.name))||servletRead){
   const name=constant(c.args[0]||[],m.owner,index);
   if(name===undefined){unresolved.add('动态字段名称无法确定：'+m.owner.name+'.'+m.name+':'+c.line);return undefined;}
   const full=b.prefix?b.prefix+'.'+name:name;
   const locations:Binding['locations']=servletRead&&c.name.startsWith('getHeader')?['header']:servletRead&&c.name.startsWith('getFile')?['form']:b.locations;
   const known=servletRead?(c.name.startsWith('getFile')?'file':'string'):readNames[c.name]||simple(assignedType||'')||(c.name==='get'&&simple(argumentsOf(b.type)[1]||''));
   add(full,locations,known||null,e);
   if(!known&&c.name!=='getJSONObject'&&c.name!=='getJSONArray'&&locations.some(loc=>!fields.get(loc+':'+full)?.type))unresolved.add('字段类型未知：'+locations.join('/')+':'+full);
   if(c.name==='getJSONObject')return {locations,prefix:full,type:'JSONObject'};
   if(c.name==='getJSONArray')return {locations,prefix:full+'[]',type:'JSONArray'};
   return {locations,prefix:full,type:assignedType||({'string':'String','integer':'Integer','number':'Double','boolean':'Boolean'} as Record<string,string>)[known||'']||'Object',scalar:full};
  }
  return undefined;
 }
 inspect(entry,bindings,0);
 // A directly read dynamic request still permits additional keys; known reads are not a closed DTO schema.
 for(const p of entry.params)if(mapType(p.type)&&fields.size)unresolved.delete('动态对象字段待核实：'+p.name);
 for(const f of fields.values())if(f.location==='query'&&fields.has('form:'+f.name)||f.location==='form'&&fields.has('query:'+f.name))f.note=[f.note,'Spring 请求参数允许 query 或 form 两种输入位置'].filter(Boolean).join('；');
 for(const f of fields.values())if(f.type){for(const issue of [...unresolved])if(issue.startsWith('字段类型未知：')&&issue.endsWith(':'+f.name))unresolved.delete(issue);}
 api.request_fields=[...fields.values()].sort((a,b)=>a.location.localeCompare(b.location)||a.name.localeCompare(b.name));
 api.unresolved=[...unresolved].sort();
}

/** Conservative admission check for model-added keys: prove a read from this handler's input.
 * Cross-file/deep/nested proposals without a verified binding stay unresolved, never guessed.
 */
export function verifyDynamicField(entry:ApiEntry,field:RequestField,index:JavaIndex):boolean{
 if(field.name.includes('.')||field.name.includes('['))return false;
 const m=index.classes.filter(c=>c.file===entry.api.file).flatMap(c=>c.methods).find(x=>x.line===entry.api.line);
 if(!m)return false;
 const inputs=new Map<string,RequestField['location'][]>();
 for(const p of m.params){
  if(mapType(p.type)&&annotation(p.annotations,'RequestBody'))inputs.set(p.name,['body']);
  else if(mapType(p.type)&&annotation(p.annotations,'RequestParam'))inputs.set(p.name,entry.api.method==='GET'?['query']:['query','form']);
  else if(servlet(p.type))inputs.set(p.name,['query','form','header']);
 }
 const localValues=new Map<string,string>();
 const decls=nodes(first(m.node,'methodBody'),'localVariableDeclaration');
 for(const declaration of decls)for(const v of nodes(declaration.children.variableDeclaratorList?.[0],'variableDeclarator')){
  const name=text(first(v,'variableDeclaratorId')),init=tokens(first(v,'variableInitializer'));
  if(init.length===1&&inputs.has(init[0].image))inputs.set(name,inputs.get(init[0].image)!);
  const value=constant(init,m.owner,index);if(value!==undefined)localValues.set(name,value);
 }
 // Reassigned or shadowed symbols require more analysis and are not accepted here.
 for(const name of [...inputs.keys(),...localValues.keys()]){
  const assignments=m.body.filter((t,i)=>t.image===name&&m.body[i+1]?.image==='=').length;
  if(assignments>(m.params.some(p=>p.name===name)?0:1)){inputs.delete(name);localValues.delete(name);}
 }
 for(const c of calls(m.body)){
  if(!inputs.get(c.receiver)?.includes(field.location)||!['get','getString','getInteger','getLong','getBoolean','getDouble','getParameter','getHeader'].includes(c.name))continue;
  if(c.name==='getHeader'&&field.location!=='header')continue;
  if(c.name==='getParameter'&&field.location==='header')continue;
  const name=c.args[0]?.length===1&&localValues.has(c.args[0][0].image)?localValues.get(c.args[0][0].image):constant(c.args[0]||[],m.owner,index);
  if(name===field.name&&field.evidence?.some(e=>e.file===m.owner.file&&e.start_line<=c.line&&e.end_line>=c.line))return true;
 }
 return false;
}
