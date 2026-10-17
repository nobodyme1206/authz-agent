/** Reservation uses measured usage and conservative transcript growth; never an exact tokenizer. */
export function requestReservation(total:number,limit:number,lastInput:number,lastOutput:number,growthBytes:number,maxOutput:number){
 const reserve=lastInput+lastOutput+Math.max(0,growthBytes)+maxOutput;
 return {remaining:Math.max(0,limit-total),estimated_next_request:reserve,allowed:total<limit&&limit-total>=reserve};
}
