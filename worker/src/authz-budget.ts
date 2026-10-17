/** A calibrated planning estimate, not a tokenizer or a hard billing guarantee. */
export function estimateContextTokens(value:unknown){
 const text=JSON.stringify(value);let word=0,estimate=0;
 const flush=()=>{estimate+=Math.ceil(word/4);word=0;};
 for(const c of text){if(/[A-Za-z0-9_]/.test(c)){word++;continue;}flush();estimate+=c.charCodeAt(0)>127?1.5:/\s/.test(c)?.125:.5;}
 flush();return Math.ceil(estimate);
}
export function requestReservation(total:number,limit:number,lastInput:number,lastOutput:number,growthTokens:number,maxOutput:number){
 const reserve=lastInput+lastOutput+Math.max(0,growthTokens)+maxOutput;
 return {remaining:Math.max(0,limit-total),estimated_next_request:reserve,allowed:total<limit&&limit-total>=reserve};
}
export function calibratedGrowth(current:number,previous:number,lastInput:number){return {calibration:Math.max(.25,Math.min(4,lastInput/Math.max(1,previous))),growth:Math.ceil(Math.max(0,current-previous)*Math.max(.25,Math.min(4,lastInput/Math.max(1,previous)))*1.25)};}

/** Preserve a final reply before another round of exploration consumes its room.
 * Includes repeated input (even cached) and bounded growth from the last tool result.
 * This is a planning estimate; actual SDK usage remains authoritative. */
export function shouldFinalize(p:{used:number;limit:number;input:number;output:number;growth:number;maxOutput:number;turns:number;maxTurns:number;tools:number;maxTools:number}){
 const next=requestReservation(p.used,p.limit,p.input,p.output,p.growth,p.maxOutput);
 const finalCost=next.estimated_next_request+p.maxOutput;
 return p.turns>=p.maxTurns-1||p.tools>=p.maxTools-2||p.limit-p.used<next.estimated_next_request+finalCost;
}
