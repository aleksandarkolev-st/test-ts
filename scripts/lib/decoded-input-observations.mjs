import assert from 'node:assert/strict';
const exact=text=>typeof text==='string'&&text.trim()?text.trim().replace(/\s+/gu,' '):null;
const digest=key=>Array.isArray(key)&&key.length===32&&key.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255);

// Retrospective input matching only, never a live reuse/display decision.
export function decodedInputObservations(row){
 const frames=(row.receivedFrames??[]).map(event=>event.payload).filter(frame=>`${frame.id}:${frame.revision}`===row.responseVersion);
 const frame=frames.at(-1);
 if(frame)assert(exact(frame.question)!==null&&exact(frame.question)===exact(row.recognizedQuestion),'Retained frame differs from recognized question');
 const prefixes=(row.provisionalPrefixes??[]).map(event=>event.payload).filter(prefix=>frame&&prefix.id===frame.id&&exact(prefix.question)===exact(frame.question));
 const known=prefixes.filter(prefix=>digest(frame.contextKey)&&digest(prefix.contextKey));
 const matching=known.filter(prefix=>prefix.contextKey.every((byte,index)=>byte===frame.contextKey[index]));
 const firstDecoded=Math.min(...matching.map(prefix=>prefix.firstWordObservedAt).filter(Number.isFinite));
 return {frame,firstDecoded:Number.isFinite(firstDecoded)?firstDecoded:null,
  differentContextObservations:known.length-matching.length,unknownContextObservations:prefixes.length-known.length};
}
