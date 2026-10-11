// Offline lexical alignment preserves raw source and ASR; it does not grade meaning.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const bytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(bytes),pressure=journal.continuousPressure;
const audit=JSON.parse(await readFile(`${directory}/pressure-events-audit.json`));
const sha256=createHash('sha256').update(bytes).digest('hex');assert.equal(audit.journalSha256,sha256);
const words=text=>[...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(match=>({word:match[0],characterOffset:match.index}));
const source=pressure.segments.flatMap(segment=>words(segment.text).map(word=>({...word,sequence:segment.sequence,clipId:segment.clipId})));
const finalAsr=audit.finalTranscripts.filter(chunk=>chunk.endedHostMs?.high>=pressure.playback.submitBeforeHostMs);
const recognized=finalAsr.flatMap(chunk=>words(chunk.text).map(word=>({...word,eventIndex:chunk.eventIndex,endedHostMs:chunk.endedHostMs})));
// Direction matrix permits exact traceback without duplicating all cost rows.
const width=recognized.length+1,directions=new Uint8Array((source.length+1)*width);
let previous=Uint32Array.from({length:width},(_,i)=>i),current=new Uint32Array(width);
for(let i=1;i<=source.length;i++){
 current[0]=i;directions[i*width]=1;
 for(let j=1;j<width;j++){
  const diagonal=previous[j-1]+Number(source[i-1].word!==recognized[j-1].word),deletion=previous[j]+1,insertion=current[j-1]+1;
  const best=Math.min(diagonal,deletion,insertion);current[j]=best;
  directions[i*width+j]=best===diagonal?0:best===deletion?1:2;
 }
 [current,previous]=[previous,current];
}
const edits=previous[recognized.length],alignment=[];let i=source.length,j=recognized.length;
while(i||j){
 const direction=i===0?2:j===0?1:directions[i*width+j];
 if(direction===0){alignment.push({kind:source[i-1].word===recognized[j-1].word?'match':'substitution',sourceIndex:i-1,recognizedIndex:j-1});i--;j--;}
 else if(direction===1){alignment.push({kind:'deletion',sourceIndex:--i,recognizedIndex:null});}
 else{alignment.push({kind:'insertion',sourceIndex:null,recognizedIndex:--j});}
}
alignment.reverse();assert.equal(alignment.filter(item=>item.kind!=='match').length,edits);
const counts={};for(const item of alignment)counts[item.kind]=(counts[item.kind]??0)+1;
const segments=pressure.segments.map(segment=>{
 const items=alignment.filter(item=>item.sourceIndex!=null&&source[item.sourceIndex].sequence===segment.sequence);
 const chunks=[...new Set(items.filter(item=>item.recognizedIndex!=null).map(item=>recognized[item.recognizedIndex].eventIndex))];
 const marker=pressure.playback.frameMarkers[segment.sequence-1];
 return {...segment,physicalEndpointHostMs:{low:marker.lowerHostMs,high:marker.upperHostMs},
  lexicalCounts:Object.fromEntries(['match','substitution','deletion'].map(kind=>[kind,items.filter(item=>item.kind===kind).length])),
  alignedRawAsrEventIndices:chunks,
  rawAsrChunks:chunks.map(index=>finalAsr.find(chunk=>chunk.eventIndex===index)),
  differences:items.filter(item=>item.kind!=='match').map(item=>({kind:item.kind,source:source[item.sourceIndex],recognized:item.recognizedIndex==null?null:recognized[item.recognizedIndex]}))};
});
const report={recordedAt:new Date().toISOString(),journalSha256:sha256,eventsSha256:audit.eventsSha256,
 model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 summary:{sourceWords:source.length,recognizedWords:recognized.length,sourceSegments:segments.length,finalAsrChunks:finalAsr.length,counts,lexicalEdits:edits,lexicalWordErrorRate:edits/source.length,
  segmentsWithLexicalDeletion:segments.filter(s=>s.lexicalCounts.deletion>0).length,segmentsWithoutAlignedRawAsr:segments.filter(s=>!s.alignedRawAsrEventIndices.length).length},
 segments,insertions:alignment.filter(item=>item.kind==='insertion').map(item=>recognized[item.recognizedIndex]),
 semanticClauseAssessmentPending:true,
 scope:'Minimum-edit global token alignment of all played source text with final ASR after playback launch. Case and punctuation are ignored; numeral/name equivalence is not guessed. Raw ASR chunks are preserved and may be shared by multiple source segments. Repeated words can admit alternative minimum-edit alignments; alignment is diagnostic, not definitive source attribution. Insertions are retained separately. Lexical edits are not semantic accuracy, missing-meaning counts or detector/context preservation. No candidate prompt, product logic or transcript was corrected.'};
if(process.argv.includes('--tokens-only')){
 const original=JSON.parse(await readFile(`${directory}/pressure-lexical-alignment.json`));
 assert.equal(original.journalSha256,sha256);assert.deepEqual(original.summary,report.summary);
 await writeFile(`${directory}/pressure-token-alignment.json`,JSON.stringify({journalSha256:sha256,eventsSha256:audit.eventsSha256,source,recognized,alignment,scope:report.scope}),{flag:'wx'});
}else await writeFile(`${directory}/pressure-lexical-alignment.json`,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,segments:undefined,insertions:undefined}));
