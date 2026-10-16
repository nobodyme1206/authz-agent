import { parse } from 'java-parser';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { safePath } from './files.ts';

export type Node = any;
export type Token = { image: string; startOffset: number; endOffset: number; startLine: number; endLine: number };
export type Evidence = {file:string;start_line:number;end_line:number};
export type Annotation = {name:string;values:Record<string,Token[]>;node:Node};
export type Variable = {name:string;type:string;annotations:Annotation[];node:Node;modifiers:string[];initializer:Token[]};
export type Method = {name:string;params:Variable[];annotations:Annotation[];node:Node;body:Token[];line:number;end:number;signature:string;owner:JavaClass};
export type JavaClass = {name:string;fqn:string;file:string;line:number;pkg:string;imports:string[];annotations:Annotation[];fields:Variable[];methods:Method[];parents:string[];typeParams:string[];modifiers:string[]};
export type ScanFile = {file:string;status:string;classes:number;reason?:string};
export type JavaIndex = {classes:JavaClass[];files:ScanFile[];diagnostics:string[];sources:Map<string,string>;resolve:(type:string,owner:JavaClass)=>JavaClass|undefined};

export function nodes(n:Node,name:string):Node[]{
 if(!n?.children)return [];
 const result=n.name===name?[n]:[];
 for(const values of Object.values(n.children) as Node[][])for(const child of values)if(child.children)result.push(...nodes(child,name));
 return result;
}
export function first(n:Node,name:string):Node|undefined{return nodes(n,name)[0];}
export function tokens(n:Node):Token[]{
 if(!n)return [];
 if(n.image!==undefined)return [n];
 const result:Token[]=[];
 for(const values of Object.values(n.children||{}) as Node[][])for(const child of values)result.push(...tokens(child));
 return result.sort((a,b)=>a.startOffset-b.startOffset);
}
export function text(n:Node):string{return tokens(n).map(t=>t.image).join('');}
export function split(ts:Token[],delimiter=','):Token[][]{
 const result:Token[][]=[[]];let depth=0;
 for(const t of ts){
  if(t.image===delimiter&&depth===0){result.push([]);continue;}
  result.at(-1)!.push(t);
  if(['(','{','[','<'].includes(t.image))depth++;
  if([')','}',']','>'].includes(t.image))depth--;
 }
 return result;
}
function annotations(modifiers:Node[]):Annotation[]{
 return modifiers.flatMap(m=>nodes(m,'annotation')).map(node=>{
  const name=text(first(node,'typeName')).split('.').at(-1)!;
  const values:Record<string,Token[]>={};
  const pairs=nodes(node,'elementValuePair');
  if(pairs.length)for(const p of pairs)values[p.children.Identifier[0].image]=tokens(p.children.elementValue[0]);
  else if(node.children.elementValue)values.value=tokens(node.children.elementValue[0]);
  return {name,values,node};
 });
}
export function annotation(list:Annotation[],name:string){return list.find(a=>a.name===name);}
export function ev(owner:JavaClass,node:Node):Evidence{
 const ts=tokens(node);return {file:owner.file,start_line:ts[0]?.startLine||1,end_line:ts.at(-1)?.endLine||ts[0]?.startLine||1};
}
function variable(node:Node,typeNode:string,mods:string):Variable{
 const id=first(node,'variableDeclaratorId');
 return {name:text(id).replace(/\[\]/g,''),type:text(first(node,typeNode))+(text(id).includes('[]')?'[]':''),annotations:annotations(node.children?.[mods]||[]),node,modifiers:(node.children?.[mods]||[]).flatMap((x:Node)=>tokens(x).map(t=>t.image)),initializer:tokens(first(node,'variableInitializer'))};
}
export function parseSource(source:string,file:string):JavaClass[]{
 const tree=parse(source) as Node;
 const pkg=text(first(tree,'packageDeclaration')).replace(/^package/,'').replace(/;$/,'');
 const imports=nodes(tree,'importDeclaration').map(text).map(t=>t.replace(/^import/,'').replace(/^static/,'').replace(/;$/,''));
 const result:JavaClass[]=[];
 function visit(n:Node,outer=''){
  if(!n?.children)return;
  if(n.name==='classDeclaration'||n.name==='interfaceDeclaration'){
   const body=n.children.normalClassDeclaration?.[0]||n.children.normalInterfaceDeclaration?.[0];
   if(body){
    const name=text(body.children.typeIdentifier?.[0]||body.children.Identifier?.[0]);
    const mods=n.children.classModifier||n.children.interfaceModifier||[];
    const cls:JavaClass={name,fqn:[pkg,outer,name].filter(Boolean).join('.'),file,line:tokens(body.children.typeIdentifier?.[0]||body.children.Identifier?.[0])[0]?.startLine||1,pkg,imports,annotations:annotations(mods),fields:[],methods:[],parents:[],typeParams:[],modifiers:mods.flatMap((x:Node)=>tokens(x).map(t=>t.image))};
    const ext=body.children.classExtends||body.children.interfaceExtends||[];
    const impl=body.children.classImplements||[];
    for(const p of [...ext,...impl]){
     const types:Node[]=[]; function collect(t:Node){if(t?.name==='classType'){types.push(t);return;}for(const v of Object.values(t?.children||{}) as Node[][])for(const x of v)collect(x);}collect(p);
     cls.parents.push(...types.map(text));
     if(!types.length){const raw=text(p).replace(/^(extends|implements)/,'');cls.parents.push(...raw.split(','));}
    }
    cls.typeParams=nodes(body.children.typeParameters?.[0],'typeParameter').map(p=>text(first(p,'typeIdentifier')));
    const b=body.children.classBody?.[0]||body.children.interfaceBody?.[0];
    for(const declaration of b?.children?.classBodyDeclaration||b?.children?.interfaceMemberDeclaration||[]){
     const member=declaration.children.classMemberDeclaration?.[0]||declaration;
     const field=member.children.fieldDeclaration?.[0]||member.children.constantDeclaration?.[0];
     if(field){
      for(const v of nodes(field.children.variableDeclaratorList?.[0],'variableDeclarator')){
       const variableNode={...field,children:{...field.children,variableDeclaratorList:undefined,variableDeclaratorId:v.children.variableDeclaratorId,variableInitializer:v.children.variableInitializer}};
       // Filter undefined child arrays before normal traversal.
       variableNode.children=Object.fromEntries(Object.entries(variableNode.children).filter(([,v])=>v));
       const f=variable(variableNode,'unannType','fieldModifier');if(member.children.constantDeclaration)f.modifiers.push('public','static','final');cls.fields.push(f);
      }
     }
     const method=member.children.methodDeclaration?.[0]||member.children.interfaceMethodDeclaration?.[0];
     if(method){
      const declarator=first(method,'methodDeclarator');if(!declarator)continue;
      const params=nodes(declarator,'formalParameter').map(p=>{
       const regular=p.children.variableParaRegularParameter?.[0]||p.children.variableArityParameter?.[0]||p;
       const v=variable(regular,'unannType','variableModifier');
       if(text(regular).includes('...'))v.type+='[]';return v;
      });
      const header=first(method,'methodHeader');const ts=tokens(header);
      const m:Method={name:declarator.children.Identifier[0].image,params,annotations:annotations(method.children.methodModifier||method.children.interfaceMethodModifier||[]),node:method,body:tokens(first(method,'methodBody')),line:ts[0]?.startLine||1,end:tokens(method).at(-1)?.endLine||1,signature:'',owner:cls};
      m.signature=m.name+'('+params.map(p=>p.type).join(',')+')';cls.methods.push(m);
     }
    }
    result.push(cls);
    for(const c of Object.values(b?.children||{}) as Node[][])for(const x of c)visitNested(x,[outer,name].filter(Boolean).join('.'));
    return;
   }
  }
  for(const values of Object.values(n.children) as Node[][])for(const child of values)visit(child,outer);
 }
 function visitNested(n:Node,outer:string){
  if(n?.name==='classDeclaration'||n?.name==='interfaceDeclaration'){visit(n,outer);return;}
  for(const values of Object.values(n?.children||{}) as Node[][])for(const c of values)if(c.children)visitNested(c,outer);
 }
 visit(tree);return result;
}
export function bare(type:string){return type.replace(/<.*>/g,'').replace(/\[\]/g,'').split('.').at(-1)!;}
export function argumentsOf(type:string):string[]{
 const a=type.indexOf('<'),b=type.lastIndexOf('>');
 if(a<0)return [];
 let depth=0,current='';const result:string[]=[];
 for(const c of type.slice(a+1,b)){if(c===','&&depth===0){result.push(current);current='';}else{current+=c;if(c==='<')depth++;if(c==='>')depth--;}}
 if(current)result.push(current);return result;
}
export async function buildIndex(root:string,include:string[],signal:AbortSignal,onProgress?:(files:ScanFile[])=>Promise<void>):Promise<JavaIndex>{
 const paths:string[]=[];const classes:JavaClass[]=[];const files:ScanFile[]=[];const sources=new Map<string,string>();const diagnostics:string[]=[];
 async function walk(dir:string){
  for(const x of (await readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(x.isSymbolicLink())continue;
   const rel=path.posix.join(dir,x.name);
   if(x.isDirectory()){if(!['.git','node_modules','target','build','dist','.idea'].includes(x.name))await walk(rel);}
   else if(x.isFile()&&x.name.endsWith('.java')&&('/'+rel).includes('/src/main/'))paths.push(rel);
  }
 }
 for(const p of include)await safePath(root,p,true);
 await walk('');
 for(const file of paths){
  if(signal.aborted)throw new Error('aborted');
  try{
   const p=await safePath(root,file);if((await lstat(p)).size>8*1024*1024)throw new Error('source_file_too_large');
   const source=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(p));
   const parsed=parseSource(source,file);classes.push(...parsed);sources.set(file,source);files.push({file,status:'parsed',classes:parsed.length});
  }catch{files.push({file,status:'failed',classes:0,reason:'java_parse_failed'});diagnostics.push(file+': java_parse_failed');}
  if(files.length%25===0&&onProgress)await onProgress([...files]);
  await yieldLoop();
 }
 if(!paths.length)diagnostics.push('no_backend_production_java_sources');
 const index:JavaIndex={classes,files,diagnostics,sources,resolve(type,owner){
  const raw=type.replace(/<.*>/g,'').replace(/\[\]/g,'');const name=bare(raw);
  const exact=classes.filter(c=>c.fqn===raw||c.fqn===owner.pkg+'.'+raw||owner.imports.includes(c.fqn)&&c.name===name);
  if(exact.length===1)return exact[0];
  const wild=classes.filter(c=>c.name===name&&owner.imports.some(i=>i.endsWith('.*')&&c.pkg===i.slice(0,-2)));
  if(wild.length===1)return wild[0];
  return undefined;
 }};
 return index;
}
