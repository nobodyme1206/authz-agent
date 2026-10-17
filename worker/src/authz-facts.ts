/** Small source facts, not a control-flow or natural-language correctness proof. */
import {nodes,tokens,ev,type Evidence,type Method,type Token} from './java-index.ts';
import {calls,constant} from './spring.ts';
import type {BackendIndex,Navigation} from './authz-index.ts';
export type GuardFact={condition:string;condition_evidence:Evidence;rejections:Evidence[];evidence:Evidence;catch_evidence:Evidence[]};
export type EffectFact={id:string;resource:string;action:string;evidence:Evidence;guards:{condition:string;evidence:Evidence}[]};
export type RouteFact={pattern:string;filter:string;evidence:Evidence};
export type AssignmentFact={target:string;property:string;value:string;method:string;evidence:Evidence;guards:{condition:string;evidence:Evidence}[]};
export type SourceFacts={assignments:AssignmentFact[];guards:GuardFact[];effects:EffectFact[];routes:RouteFact[];mutations:{call:string;evidence:Evidence;guards:{condition:string;evidence:Evidence}[]}[]};
export function contains(outer:Evidence,inner:Evidence){return outer.file===inner.file&&outer.start_line<=inner.start_line&&outer.end_line>=inner.end_line;}
function range(m:Method,ts:Token[]):Evidence{return {file:m.owner.file,start_line:ts[0].startLine,end_line:ts.at(-1)!.endLine};}
function branches(m:Method){return nodes(m.node,'ifStatement').flatMap(n=>{
 const ts=tokens(n),open=ts.findIndex(t=>t.image==='(');let depth=1,end=open+1;
 for(;end<ts.length&&depth;end++){if(ts[end].image==='(')depth++;if(ts[end].image===')')depth--;}
 if(open<0||depth||!ts[end])return [];
 let stop=end;if(ts[end].image==='{'){depth=1;for(stop=end+1;stop<ts.length&&depth;stop++){if(ts[stop].image==='{')depth++;if(ts[stop].image==='}')depth--;}}
 else{while(stop<ts.length&&ts[stop].image!==';')stop++;stop++;}
 const body=ts.slice(end,stop),predicate=ts.slice(open+1,end-1);
 if(!predicate.length||!body.length)return [];
 const rejection=body.flatMap((t,i)=>{if(!['throw','return'].includes(t.image))return [];let j=i;while(j<body.length&&body[j].image!==';')j++;return [range(m,body.slice(i,Math.min(j+1,body.length)))];});
 const catch_evidence=nodes(m.node,'tryStatement').flatMap(t=>{
  const all=tokens(t),at=all.findIndex(t=>t.image==='catch');if(at<0||!rejection.length)return [];
  // A catch can intercept an exception, never an ordinary rejecting return.
  const throws=body.filter(t=>t.image==='throw').map(t=>range(m,[t]));
  if(!throws.some(r=>contains(range(m,all.slice(0,at)),r)))return [];
  return [range(m,all.slice(at))];
 });
 return [{condition:predicate.map(t=>t.image).join(' '),condition_evidence:range(m,predicate),rejections:rejection,evidence:range(m,ts.slice(0,stop)),catch_evidence,body}];
 });}
export function sourceFacts(index:BackendIndex,nav:Navigation):SourceFacts{
 const facts:SourceFacts={assignments:[],guards:[],effects:[],routes:[],mutations:[]};
 const relevant=index.classes.flatMap(c=>c.methods).filter(m=>nav.nodes.some(n=>n.file===m.owner.file&&n.symbol===m.owner.fqn+'.'+m.signature)||m.owner.name==='MybatisInterceptor');
 for(const m of relevant){
  const bs=branches(m);if(m.owner.name!=='MybatisInterceptor')facts.guards.push(...bs.filter(b=>b.rejections.length).map(({body,...b})=>b));
  for(const call of calls(m.body)){
   const guards=bs.filter(b=>b.body[0].startOffset<=call.start&&b.body.at(-1)!.endOffset>=call.end).map(b=>({condition:b.condition,evidence:b.condition_evidence}));
   const evidence={file:m.owner.file,start_line:call.line,end_line:call.line};
   if(/^set[A-Z]/.test(call.name)&&call.receiver&&call.args.length===1){const property=call.name[3].toLowerCase()+call.name.slice(4);facts.assignments.push({target:call.receiver,property,value:call.args[0].map(t=>t.image).join(' '),method:m.owner.fqn+'.'+m.signature,evidence,guards});}
   if(m.owner.name==='MybatisInterceptor'&&call.name==='set')facts.mutations.push({call:call.receiver+'.set('+call.args.map(a=>a.map(t=>t.image).join('')).join(',')+')',evidence,guards});
   const candidate=nav.candidates.find(c=>c.kind==='operation'&&c.evidence.file===evidence.file&&c.call_start===call.start);
   if(candidate){
    const action=['insert','update','delete'].includes(candidate.action||'')?candidate.action!:/^(save|insert)/i.test(call.name)?'insert':/^(remove|delete)/i.test(call.name)?'delete':/^update/i.test(call.name)?'update':'read';
    // Only concrete program-located mutations are coverage obligations; queries are navigation.
    const resource=candidate.resource||'';
    if(resource&&action!=='read')facts.effects.push({id:'effect:'+m.owner.file+':'+call.start,resource,action,evidence,guards});
   }
  }
 }
 for(const c of index.classes.filter(c=>c.name==='ShiroConfig'))for(const m of c.methods)for(const call of calls(m.body)){
  if(call.name!=='put'||call.args.length!==2)continue;
  const pattern=constant(call.args[0],c,index),filter=constant(call.args[1],c,index);
  if(pattern?.startsWith('/')&&filter)facts.routes.push({pattern,filter,evidence:{file:c.file,start_line:call.line,end_line:call.line}});
 }
 return facts;
}
