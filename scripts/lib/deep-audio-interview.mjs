// Evaluation only: audio capture and recorded painted text, never production routing.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installPaintedAnswerRecorder} from './painted-answer-recorder.mjs';
import {publicContextCheckpoint,replayContextCheckpoint} from './deep-replay-context.mjs';
import {streamedWordLatency} from './streamed-word-latency.mjs';
import {continueInterview,interviewStopReason} from './interview-duration.mjs';
import {changedJobObservation,deepDeliveryRound,immediateContextProbe} from './deep-observations.mjs';
import {gradeWithRetry} from './examiner-retry.mjs';
import {explicitContextProbe,questionPause,waveformEvidence} from './deep-delivery.mjs';
import {runContinuousPressure} from './continuous-pressure.mjs';
import {olderCodeProbe} from './older-code-probe.mjs';
import {examinerPublicHistory} from './examiner-public-history.mjs';
import {exactPauseWave} from './exact-pause-wave.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const styles={2:'Use a very short contextual follow-up grounded in the actual answer.',
 4:'Add a decisive constraint at the END; include a late explicit negation that changes the valid solution.',
 5:'Abruptly switch to a technical topic OUTSIDE this interview domain, with enough public facts to answer.',
 7:'Present a plausible FALSE premise; a correct answer must reject it rather than accept it.',
 8:'Ask a long multipart question with an important final condition; demand quantitative or executable reasoning.',
 9:'Debug concrete code or trace from the actual previous answer.',
 10:'Demand concrete executable implementation and edge cases.',
 12:'Challenge an actual unsupported claim with a counterexample or changed boundary.'};

export async function runDeepAudioInterview(ctx){
 const {root,output,result,rounds,budget,scenario,seedQuestion,invoke,connection,eventCount,events,runChild,persist,
  playbackName,examiner,examinerModel,examinerEffort}=ctx;
 assert(result.realAudio,'Deep interviews require actual capture/ASR, not injected transcripts');
 assert(!result.intentClassifier,'Classifier training and learned classifier activation stay disabled');
 const replayFile=process.env.COPILOT_DEEP_REPLAY_FILE;
 const source=replayFile?JSON.parse(await readFile(path.resolve(replayFile),'utf8')):null;
 const delivery=scenario.evaluationDelivery??{};
 if(source)assert(source.status==='complete'&&source.rows.length>=12,'Replay requires a completed adaptive pilot');
 result.evaluationKind=source?'paired_fixed_audio_replay':'answer_adaptive_audio_pilot';
 result.primaryLatencyMetric='Last voiced playback sample to first complete streamed word visibly rendered in the actual overlay. No wait for answer completion or grading. Correctness and retention are reported separately.';
 result.secondaryLatencyMetric='First correct useful retained phrase in actually painted overlay text, independently selected after execution.';
 result.endpointDefinition='Last nonzero PCM frame of synthetic question observed via waveOut device position. Position-crossing host interval is retained; native/host clock calibration and painted-text observations preserve timing uncertainty. This is synthetic playback, not human speech or an acoustic-room measurement.';
 result.classifierTrainingStopped=true;
 result.deepObservations=[];result.overlayPaintSamples=[];result.pollErrors=[];
 result.backgroundPlaybacks=[];
 result.deliveryPlan={styles,overlapAfterRounds:[3,6,9],internalPauseRounds:[4,8],pauseMs:1500,repeatEveryRounds:12,
  immediateContextProbeAfterRounds:[1,5,10],immediateProbeScope:'Prepared short public follow-up delivered as soon as an actual visible answer prefix is observed, without waiting for examiner generation. Actual overlap is verified from running-at-launch evidence.',
  scope:'Delivery constraints guide adaptive generation, not a fixed question list or hidden candidate prompt.'};
 result.deliveryPlan.caseOverrides=delivery;
 await connection.overlay.evaluate(()=>{window.deepPaintSamples=[];});
 await connection.overlay.evaluate(installPaintedAnswerRecorder);
 const clockAnchor=async()=>{
  const before=Date.now(),state=await invoke('acceptance_jobs'),after=Date.now();
  return {hostBeforeMs:before,hostAfterMs:after,nativeMs:state.nativeNow};
 };
 result.deepObservationFormat='changed_jobs_sparse_context';
 result.recorderResources=[];
 let sampling=true,lastSave=0,paintOffset=0,lastResource=0;
 const latest=new Map();
 const fingerprints=new Map();
 let pollInFlight=null;
 const poll=async()=>{
  if(pollInFlight)return pollInFlight;
  pollInFlight=sample();
  try{return await pollInFlight;}finally{pollInFlight=null;}
 };
 const sample=async()=>{
  const before=Date.now(),state=await invoke('acceptance_jobs'),after=Date.now();
  for(const job of state.jobs)latest.set(job.question.id,job);
  const previous=result.deepObservations.at(-1),record=changedJobObservation(state,fingerprints,{hostBeforeMs:before,hostAfterMs:after});
  if(record.jobs.length||!previous||after-previous.hostAfterMs>=1000)result.deepObservations.push(record);
  const painted=await connection.overlay.evaluate(offset=>window.deepPaintSamples.slice(offset),paintOffset);
  assert(Array.isArray(painted),'Overlay recorder lost its page context; visible timing is unavailable');
  result.overlayPaintSamples.push(...painted);paintOffset+=painted.length;
  if(after-lastResource>=10000){lastResource=after;result.recorderResources.push({hostMs:after,pollMs:after-before,...process.memoryUsage(),
   scope:'Node recording process memory, not native app or GPU memory.'});}
  const current=result.rows.at(-1);
  if(current?.audio?.playback&&!current.firstStreamedWordMeasurement){
   const measurement=streamedWordLatency(result,current);
   if(measurement.firstVisibleStreamedWord){
    current.firstStreamedWordMeasurement=measurement;
    console.log(`FIRST STREAMED WORD round-${current.round}: ${JSON.stringify(measurement.firstVisibleStreamedWord.word)}, ${measurement.firstVisibleStreamedWord.latencyMs.high} ms after playback speech end`);
   }
  }
  if(Date.now()-lastSave>10000){lastSave=Date.now();await persist();}
  return {hostBeforeMs:before,hostAfterMs:after,...state};
 };
 const sampler=(async()=>{while(sampling){try{await poll();}catch(error){result.pollErrors.push(String(error));}await sleep(50);}})();
 const prepareAudio=async(question,label,replayRow)=>{
  const textFile=path.join(output,`${label}.txt`),waveFile=path.join(output,`${label}.wav`);
  await writeFile(textFile,question,'utf8');
  let pause={split:0,pauseMs:0,kind:'recorded_waveform_replay'};
  if(replayRow){
   const original=path.resolve(path.dirname(replayFile),replayRow.audio.waveFile);
   const bytes=await readFile(original);assert.equal(hash(bytes),replayRow.audio.sha256);
   await writeFile(waveFile,bytes,{flag:'wx'});
  }else{
   const round=Number(label.match(/\d+/)?.[0]);
   pause=questionPause(question,round,delivery,[4,8].includes(deepDeliveryRound(round)));
   if(pause.split>0&&delivery.exactDigitalPause===true){
    const pieces=[question.slice(0,pause.split),question.slice(pause.split)],waves=[];
    for(const [index,piece] of pieces.entries()){
     const partText=path.join(output,`${label}-part-${index+1}.txt`),partWave=path.join(output,`${label}-part-${index+1}.wav`);
     await writeFile(partText,piece,'utf8');
     await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/synthesize-interview-question.ps1'),'-TextPath',partText,'-OutputPath',partWave],process.env);
     waves.push(await readFile(partWave));
    }
    const composed=exactPauseWave(waves[0],waves[1],pause.pauseMs);
    await writeFile(waveFile,composed.wave);pause={...pause,...composed.evidence};
   }else{
    const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/synthesize-interview-question.ps1'),'-TextPath',textFile,'-OutputPath',waveFile];
    if(pause.split>0)args.push('-PauseAfterCharacters',String(pause.split),'-PauseMs',String(pause.pauseMs));
    await runChild('powershell.exe',args,process.env);
   }
  }
  const bytes=await readFile(waveFile);
  return {waveFile:path.basename(waveFile),sha256:hash(bytes),waveformEvidence:waveformEvidence(bytes,pause,
   Number(label.match(/\d+/)?.[0])===1?delivery:{})};
 };
 const play=async(audio,label,device=playbackName)=>{
  const timingFile=path.join(output,`${label}.playback.json`),before=await clockAnchor();
  const atStart=await invoke('acceptance_jobs');
  const publicPriorContext=publicContextCheckpoint(atStart,{hostMs:Date.now(),nativeMs:atStart.nativeNow});
  await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-fixture-device.ps1'),
   '-InputPath',path.join(output,audio.waveFile),'-OutputName',device,'-TimingPath',timingFile],process.env);
  const after=await clockAnchor(),timing=JSON.parse(await readFile(timingFile,'utf8'));
  return {...audio,playback:timing,clockAnchors:[before,after],publicPriorContext,runningAtPlaybackLaunch:atStart.jobs.filter(j=>j.running&&!j.cancelled).map(j=>j.question.id)};
 };
 const jobsSince=ids=>[...latest.values()].filter(j=>!ids.has(j.question.id));
 const awaitJob=async(ids,{prefixOnly=false}={})=>{
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
   const state=await poll();
   if(state.view.error){
    const failed=jobsSince(ids).findLast(j=>j.error)??jobsSince(ids).at(-1);
    return failed?{...failed,error:state.view.error}:null;
   }
   const candidates=jobsSince(ids).filter(j=>j.confirmed&&!j.cancelled).sort((a,b)=>a.question.detectedAt-b.question.detectedAt);
   const job=candidates.at(-1);
   const painted=job&&result.overlayPaintSamples.findLast(s=>s.questionId===job.question.id&&s.visible&&s.text);
   if(job&&(job.error||job.phase==='ignored'||job.latency.completedAt!=null||(prefixOnly&&painted?.text.length>=60)))return job;
   await sleep(50);
  }
  return jobsSince(ids).at(-1)??null;
 };
 const introduction='INTERVIEWER INTRODUCTION: Technical hypothetical interview; ask for missing facts rather than inventing them.\n';
 const sessionClock=performance.now();
 result.interviewSessionStartedAt=new Date().toISOString();
 const examine=async(row,label,partial=false)=>{
  const request=path.join(output,`${label}.examiner.json`);
  const publicHistory=examinerPublicHistory(result.rows,row,latest,introduction)+`\nINTERVIEWER: ${row.question}\nACTUAL CANDIDATE ANSWER${partial?' (partial, still streaming; choose next question from actual claims; grading is provisional)':''}: ${row.answer}\n`;
  const plan={...result.interviewPlan,currentRound:row.round,elapsedMs:performance.now()-sessionClock,nextDeliveryInstruction:
   row.round>=20&&row.round%12===0?'Refer precisely to an actual earlier code implementation from at least 20 turns ago, name its version or distinguishing constraint, and ask to revise it. Supply no private rubric facts.':
   styles[deepDeliveryRound(row.round+1)]??'Deepen actual claims through mechanisms, assumptions, edge cases, exact code or counterexamples.',
   streamingPartial:partial,pilotLength:rounds,spokenQuestionLimit:'Maximum 120 spoken words. Do not recite large code blocks; describe a small precise program verbally or ask the candidate to supply executable code. Spell out essential negative values as negative six rather than a raw minus sign, and name each required comparison or operator. Speak requested exact sentinel strings character by character, including their sign. Do not embed raw numeric tuples whose missing punctuation could change edge endpoints or signs. Long multipart questions may use the full 120 words. Keep exact constraints, proofs and technical difficulty. If the candidate timed out, preserve that failure and probe another claim or a new concise, fully specified problem.'};
  await writeFile(request,JSON.stringify({scenario,round:row.round,history:publicHistory,interviewPlan:plan},null,2));
  const attempts=[];
  await gradeWithRetry(()=>runChild(examiner,['--grade-request',request],{...process.env,COPILOT_INTERVIEW_EXAMINER_MODEL:examinerModel,COPILOT_INTERVIEW_EXAMINER_EFFORT:partial?'low':examinerEffort}),
   {attempts:result.reviewAttemptLimit??1,onAttempt:async attempt=>{attempts.push(attempt);row.examinerAttempts=attempts;await persist();}});
  const judged=JSON.parse(await readFile(request.replace(/\.json$/,'.review.json'),'utf8'));
  return {file:path.basename(request),review:judged.review,partial,effort:partial?'low':examinerEffort,attempts};
 };
 try{
  if(delivery.continuousPressure){
   await runContinuousPressure({root,output,result,delivery,runChild,invoke,poll,persist,latest,playbackName});
   return;
  }
  let question=seedQuestion,prepared=null;
  const trials=source?source.rows.flatMap((row,i)=>(i%2?['existing','final']:['final','existing']).map(policy=>({row,policy}))):Array.from({length:rounds},()=>null);
  for(let index=0;index<trials.length;index++){
   if(!source&&!continueInterview(budget,index+1,performance.now()-sessionClock))break;
   const trial=trials[index],round=trial?trial.row.round:index+1,label=trial?`round-${String(round).padStart(2,'0')}-${trial.policy}`:`round-${String(round).padStart(2,'0')}`;
   const deliveryRound=deepDeliveryRound(round);
   if(!trial&&round>1&&deliveryRound===1){
    const text='Side conversation, no reply needed. The room booking has moved to tomorrow. I will send the address later. We are still waiting for the others.';
    const backgroundOffset=await eventCount(),background=await prepareAudio(text,`background-before-${round}`);
    const audio=await play(background,`background-before-${round}`);
    result.backgroundPlaybacks.push({beforeRound:round,text,audio,events:await events(backgroundOffset),
     scope:'Public background statement asks for no reply. Capture, routing and later context retention require assessment; not automatically counted as ignored.'});
    await persist();
   }
   const memoryProbe=!trial&&process.env.COPILOT_DEEP_OLDER_CODE_PROBE==='1'&&!result.olderCodeProbe?
    olderCodeProbe(result.rows,latest,round+1):null;
   const probe=!trial&&continueInterview(budget,round+1,performance.now()-sessionClock)?
    memoryProbe?.text??explicitContextProbe(delivery,round+1,immediateContextProbe(round+1)):null;
   const probeAudio=probe?await prepareAudio(probe,`round-${String(round+1).padStart(2,'0')}`):null;
   let frozen=null;
   if(trial){
    question=trial.row.question;await invoke('action',{action:'dismiss'});await sleep(600);
    frozen=replayContextCheckpoint(source,trial.row);
    await invoke('acceptance_freeze_context',{context:frozen.text,policy:trial.policy});
   }
   const offset=await eventCount(),ids=new Set(latest.keys());
   const audio=prepared??await prepareAudio(question,label,trial?.row);prepared=null;
   const played=await play(audio,label);
   const row={round,trial:index+1,policy:trial?.policy??result.intentMode,question,audio:played,
    answer:'',responseVersion:null,recognizedQuestion:null,latency:null,phase:'awaiting_observation',
    selectedContext:null,eventOffset:offset,provisionalReview:null};
   result.rows.push(row);await persist();
   let job=await awaitJob(ids,{prefixOnly:!trial&&(Boolean(probe)||[3,6,9].includes(deliveryRound))});
   Object.assign(row,{
    answer:job?.answer??'',responseVersion:job?`${job.question.id}:${job.latency.responseRevision??0}`:null,
    recognizedQuestion:job?.question.text??null,latency:job?.latency??null,phase:job?.phase??'no_job',
    selectedContext:job?.selectedContext??null,error:job?.error??null,cancelled:job?.cancelled??false});await persist();
   let next=null;
   if(!trial&&!result.speechConfiguration.remoteOnly&&[6,9].includes(deliveryRound)&&process.env.COPILOT_DEEP_SELF_OUTPUT){
     const selfOffset=await eventCount();
     const selfText='Hold on. I want to check the assumptions before we continue.';
     const selfAudio=await prepareAudio(selfText,label+'-self');
     row.selfPlayback={text:selfText,audio:await play(selfAudio,label+'-self',process.env.COPILOT_DEEP_SELF_OUTPUT),events:await events(selfOffset)};
   }
   if(probe&&job?.answer){
    row.followupBasis={partialAnswer:row.answer,responseVersion:row.responseVersion,hostMs:Date.now()};
    row.nextDeliveryOrigin='prepared_contextual_probe_after_actual_visible_answer';
    row.reviewPending=true;next=probe;prepared=probeAudio;
    if(memoryProbe){result.olderCodeProbe=memoryProbe;row.nextDeliveryOrigin='public_older_implementation_reference';}
   }else if(!trial&&continueInterview(budget,round+1,performance.now()-sessionClock)&&[3,6,9].includes(deliveryRound)&&job?.running){
    row.followupBasis={partialAnswer:row.answer,responseVersion:row.responseVersion,hostMs:Date.now()};
    row.provisionalReview=await examine(row,label+'-partial',true);next=row.provisionalReview.review.question;
    prepared=await prepareAudio(next,`round-${String(round+1).padStart(2,'0')}`);
    // Never await candidate completion here. The next question uses the real
    // answer observed above, with running-at-launch evidence recorded next turn.
   }else if(!trial){
    job=await awaitJob(ids);row.answer=job?.answer??row.answer;row.latency=job?.latency??row.latency;
    row.responseVersion=job?`${job.question.id}:${job.latency.responseRevision??0}`:row.responseVersion;
    row.selectedContext=job?.selectedContext??row.selectedContext;
    row.error=job?.error??row.error;
    row.reviewRecord=await examine(row,label);row.review=row.reviewRecord.review;next=row.review.question;
   }
   if(trial){
    row.frozenContextSha256=hash(Buffer.from(frozen.text));
    row.frozenContextProvenance=frozen.provenance;
    row.contextMatches=job?.selectedContext==null?null:job.selectedContext===frozen.text;
    row.sourceRow={file:replayFile,round,answerSha256:hash(Buffer.from(trial.row.answer))};
    if(job?.selectedContext!=null)assert(row.contextMatches,'Replay context changed');
   }
   row.events=await events(offset);
   if(next)question=next;
   if(row.error||row.phase==='no_job'){
    await invoke('action',{action:'dismiss'});await sleep(700);
    row.recoveredByDismiss=true;
   }
   console.log(`Deep audio ${label}: ${row.phase}, ${row.answer.length} answer chars, raw first char ${row.latency?.firstWordAt-row.latency?.speechStoppedAt} ms`);
   result.actualInterviewDurationMs=performance.now()-sessionClock;
   await persist();
  }
  await sleep(1500);await poll();
  // Refresh early interrupted answers from final authoritative native jobs.
  for(const row of result.rows){
   const id=row.responseVersion?.split(':')[0],job=latest.get(id);
   if(job){row.answer=job.answer;row.latency=job.latency;row.phase=job.phase;row.cancelled=job.cancelled;row.error=job.error;
    row.selectedContext=job.selectedContext;row.responseVersion=`${id}:${job.latency.responseRevision??0}`;}
   row.firstStreamedWordMeasurement=streamedWordLatency(result,row);
  }
  result.actualInterviewDurationMs=performance.now()-sessionClock;
  result.stopReason=source?'paired_replay_reached':interviewStopReason(budget,result.rows.length,result.actualInterviewDurationMs);
  assert(result.stopReason!=='round_cap_before_duration','Round cap exhausted before the requested interview duration');
  result.status='complete';result.targetAchieved=false;result.evaluatedTurnCount=result.rows.length;
 }finally{sampling=false;await sampler;await poll();await persist();}
}
