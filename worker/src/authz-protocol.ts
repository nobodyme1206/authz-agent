/** Internal transport helpers. They supply source locations, never policy answers. */
import {createHash} from 'node:crypto';
import type {Evidence} from './java-index.ts';
import type {Navigation} from './authz-index.ts';
import type {AuthSubmission} from './stage2.ts';
import {contains,type GuardFact,type SourceFacts} from './authz-facts.ts';
export function covered(e:Evidence,reads:Evidence[]){let n=e.start_line;for(const r of reads.filter(r=>r.file===e.file).sort((a,b)=>a.start_line-b.start_line)){if(r.start_line>n)break;n=Math.max(n,r.end_line+1);if(n>e.end_line)return true;}return false;}
export type ProofRef={id:string;kind:string;label:string;evidence:Evidence};
export function proofCatalog(reads:Evidence[],nav:Navigation,guards:GuardFact[]):ProofRef[]{
 const candidates=[...nav.candidates.filter(c=>['operation','sql','annotation'].includes(c.kind)).map(c=>({kind:c.kind,label:c.description,evidence:c.evidence})),...guards.flatMap(g=>[{kind:'predicate',label:g.condition,evidence:g.condition_evidence},...g.rejections.map(e=>({kind:'rejection',label:'return/throw; effect must be verified',evidence:e}))]),...reads.map(e=>({kind:'source',label:'actual read range',evidence:e}))];
 const seen=new Set<string>();return candidates.filter(c=>covered(c.evidence,reads)).flatMap(c=>{const id='p'+createHash('sha256').update(JSON.stringify(c.evidence)).digest('hex').slice(0,12);if(seen.has(id))return [];seen.add(id);return [{id,...c}];});
}
export function resolveProofRefs(p:AuthSubmission,refs:ProofRef[]){
 const get=(id:string)=>{const r=refs.find(r=>r.id===id);if(!r)throw new Error('unknown_or_unread_proof_id: '+id);return structuredClone(r.evidence);};
 for(const o of p.operations){if(o.anchor_id){const r=refs.find(r=>r.id===o.anchor_id);if(!r||!['operation','sql'].includes(r.kind))throw new Error('invalid_operation_anchor_id: '+o.anchor_id);o.anchor=get(o.anchor_id);}o.evidence=[...o.evidence||[],...(o.evidence_ids||[]).map(get)];if(!o.evidence.length&&o.anchor)o.evidence=[structuredClone(o.anchor)];}
 for(const c of p.checks){c.evidence=[...c.evidence||[],...(c.evidence_ids||[]).map(get)];c.effect_evidence=[...c.effect_evidence||[],...(c.effect_evidence_ids||[]).map(get)];}
 const unique=(items:Evidence[])=>items.filter((e,i,a)=>a.findIndex(x=>JSON.stringify(x)===JSON.stringify(e))===i);
 for(const o of p.operations)o.evidence=unique(o.evidence);for(const c of p.checks){c.evidence=unique(c.evidence);c.effect_evidence=unique(c.effect_evidence||[]);}
 return p;
}
export function verifyRequestSources(p:AuthSubmission,fields:{name:string;location:string}[]){
 const known=new Set(fields.map(f=>f.location+':'+f.name));
 const check=(text:string,identity=false)=>{for(const hit of text.matchAll(/\b(body|query|path|form|header):([A-Za-z_$][\w$-]*(?:\[\])?(?:\.[\w$]+(?:\[\])?)*)/g)){
  const token=hit[1]==='header'||hit[1]==='query'&&hit[2]==='token';
  if(!known.has(hit[0])&&!(identity&&token))throw new Error('binding_source_mismatch: '+hit[0]+'; frozen refs='+JSON.stringify([...known])+'; identity/database values are not request fields');
 }};
 for(const op of p.operations)check(op.description);
 for(const c of p.checks){check(c.rule,c.kind==='authentication'&&!c.fields.length);for(const b of c.bindings||[])check(b.source,c.kind==='authentication'&&!c.fields.length);}
}
/** Reject bounded, explicit blanket-overwrite contradictions; not general NL verification. */
export function verifyAssignmentClaims(p:AuthSubmission,facts:SourceFacts,nav:Navigation,reads:Evidence[]){
 for(const op of p.operations){
  const anchor=op.anchor||op.evidence?.[0];if(!anchor)continue;
  const method=nav.nodes.find(n=>contains({file:n.file,start_line:n.start_line,end_line:n.end_line},anchor));if(!method)continue;
  const assignments=facts.assignments.filter(a=>a.method===method.symbol&&covered(a.evidence,reads)&&!nav.disabled.some(d=>contains(d,a.evidence)));
  if(!assignments.length)continue;
  const unchanged=/(请求(体|字段)?|实体|request|entity|payload|all fields)[^。；;]{0,30}(原样|unchanged|without changes)|(原样|unchanged)[^。；;]{0,30}(请求|实体|request|entity|payload|all fields)/i.test(op.description);
  const only=/(仅(?!当|在)|只(?!在|有)|only(?!\s+(?:if|when)))[^。；;]{0,60}(覆盖|修改|赋值|overwrit|modif|assign)/i.test(op.description);
  const named=assignments.filter(a=>op.description.includes(a.property));
  if((unchanged||only)&&named.length<new Set(assignments.map(a=>a.property)).size)throw new Error('operation_description_conflicts_with_assignments: '+JSON.stringify(assignments.map(a=>({target:a.target,property:a.property,value:a.value,evidence:a.evidence,guards:a.guards}))));
 }
}
export function correctionSource(p:AuthSubmission,refs:ProofRef[],reads:Evidence[],sources:Map<string,string>,maxChars=16000){
 const requested=[...p.operations.flatMap(o=>[...o.evidence||[],...o.anchor?[o.anchor]:[]]),...p.checks.flatMap(c=>[...c.evidence||[],...c.effect_evidence||[]]),...refs.filter(r=>r.kind!=='source').map(r=>r.evidence)];
 const blocks:{file:string;start_line:number;end_line:number;content:string}[]=[];let size=0;
 for(const e of requested){if(!covered(e,reads)||blocks.some(b=>contains(b,e)))continue;const source=sources.get(e.file);if(!source)continue;const lines=source.split(/\r?\n/);const content=lines.slice(e.start_line-1,e.end_line).map((l,i)=>(e.start_line+i)+': '+l).join('\n');if(size+content.length>maxChars)continue;blocks.push({...e,content});size+=content.length;}
 return {blocks,proof_refs:refs.filter(r=>blocks.some(b=>contains(b,r.evidence))),truncated:requested.some(e=>covered(e,reads)&&!blocks.some(b=>contains(b,e)))};
}
