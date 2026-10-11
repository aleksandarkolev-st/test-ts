import {readFile} from 'node:fs/promises';
for(const name of process.argv.slice(2)){
 const j=JSON.parse(await readFile(`artifacts/deep-interview-v70/hard-probes/${name}/interview.json`));
 const row=j.rows.at(-1),id=row.responseVersion.split(':')[0];
 const paints=j.overlayPaintSamples.filter(p=>p.visible&&p.recorderVersion===2&&p.hostMs>=row.audio.playback.submitBeforeHostMs);
 console.log(JSON.stringify({name,sourceQuestion:row.question,recognizedQuestion:row.recognizedQuestion,
  previousTagPaints:paints.filter(p=>p.questionId!==id).map(p=>({hostMs:p.hostMs,id:p.questionId,text:p.text.slice(p.visibleStart,p.visibleEnd)})),
  firstCurrent:paints.find(p=>p.questionId===id),events:row.events?.length}));
}
