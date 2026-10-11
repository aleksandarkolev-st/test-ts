import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [input,output]=process.argv.slice(2);assert(input&&output,'ROW_CHECKPOINT OUTPUT_JSON');
const hash=x=>createHash('sha256').update(x).digest('hex'),bytes=await readFile(input),row=JSON.parse(bytes),p=row.pipeline??{};
const difference=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)?end-start:null;
const anchors=row.audioClockAnchors??[];
const low=anchors.length?Math.max(...anchors.map(anchor=>anchor.nativeMs-anchor.hostAfterMs)):null;
const high=anchors.length?Math.min(...anchors.map(anchor=>anchor.nativeMs-anchor.hostBeforeMs)):null;
const playback=row.audioPlayback,calibrated=Number.isFinite(low)&&Number.isFinite(high)&&low<=high&&playback;
const physicalEnd=calibrated?{low:playback.lastVoicedDevicePositionLowerHostMs+low,high:playback.lastVoicedDevicePositionUpperHostMs+high}:null;
const intervalFromPhysicalEnd=timestamp=>physicalEnd&&Number.isFinite(timestamp)?{low:timestamp-physicalEnd.high,high:timestamp-physicalEnd.low}:null;
const firstPostCleanupPrefix=Number.isFinite(p.cleanupTerminalAt)?(row.frameEvents??[]).find(event=>event.name==='answer.provisional_prefix'&&event.payload?.observedAt>=p.cleanupTerminalAt):null;
const timestampFields=['latestInputSent','latestInputReaderReceived','latestInputConsumed','retainedFirstDelta'];
const ordered=timestampFields.every(field=>Number.isFinite(p[field]))&&timestampFields.slice(1).every((field,index)=>p[field]>=p[timestampFields[index]]);
const prefixFrames=[...new Map((row.frameEvents??[]).filter(event=>event.name==='answer.provisional_prefix').map(event=>[JSON.stringify(event),event.payload])).values()]
 .sort((a,b)=>a.observedAt-b.observedAt);
const observedActivity=(start,end)=>{
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return null;
 const frames=prefixFrames.filter(frame=>frame.observedAt>=start&&frame.observedAt<end);
 const framing=[...new Map(frames.map(frame=>[JSON.stringify([frame.question,frame.contextKey,frame.revision]),frame])).values()].map(frame=>({
  question:frame.question,contextKey:frame.contextKey,revision:frame.revision,
  matchesRecordedRecognizedQuestionExactly:typeof row.recognizedQuestion==='string'&&frame.question===row.recognizedQuestion,
  remainingRecognizedSuffix:typeof frame.question==='string'&&frame.question.length>0&&typeof row.recognizedQuestion==='string'&&row.recognizedQuestion.startsWith(frame.question)?row.recognizedQuestion.slice(frame.question.length):null}));
 return {intervalNativeMs:{start,end},decodedPrefixFrames:frames.length,framing,frames,
  scope:'Recorded bounded decoded-prefix observations establish output activity. Their absence does not establish absence of provider or transport work. Question/context framing can be obsolete; these frames are not counted as retained visible words.'};
};
const report={recordedAt:new Date().toISOString(),evidence:{file:input,sha256:hash(bytes)},
 collectorSha256:hash(await readFile(new URL(import.meta.url))),round:row.round,responseVersion:row.responseVersion,
 sourceQuestionSha256:row.sourceQuestionSha256??hash(row.question??''),question:row.question,phase:row.phase,cancelled:row.cancelled??null,error:row.error??null,
 retainedVisibleWord:row.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord??row.word??null,
 inputTimelineOrdered:ordered,physicalVoicedEndpointNativeMs:physicalEnd,
 stagesMs:{physicalEndToConfirmation:intervalFromPhysicalEnd(p.questionConfirmed),confirmationToFinalSend:difference(p.latestInputSent,p.questionConfirmed),
  finalSendToMatchingReaderReceipt:difference(p.latestInputReaderReceived,p.latestInputSent),matchingReaderReceiptToConsumer:difference(p.latestInputConsumed,p.latestInputReaderReceived),
  consumerToRetainedDecodedDelta:difference(p.retainedFirstDelta,p.latestInputConsumed),retainedDecodedDeltaToNativeVisible:difference(p.firstVisible,p.retainedFirstDelta)},
 separateAckWaitMs:difference(p.latestInputAck,p.latestInputSent),cleanupRelativeToPhysicalEndMs:intervalFromPhysicalEnd(p.cleanupTerminalAt),
 observedDecodedPrefixActivity:{waitingToSend:observedActivity(p.questionConfirmed,p.latestInputSent),
  submittedWaitingForReceipt:observedActivity(p.latestInputSent,p.latestInputReaderReceived),
  consumedWaitingForRetainedDelta:observedActivity(p.latestInputConsumed,p.retainedFirstDelta)},
 firstDecodedPrefixAfterCleanup:firstPostCleanupPrefix?.payload??null,firstPostCleanupPrefixRelativeToPhysicalEndMs:intervalFromPhysicalEnd(firstPostCleanupPrefix?.payload?.observedAt),
 counters:{restarts:p.refinementRestartCount,steers:p.steeringCount,followups:p.followupCount,promptChars:p.promptChars,restartPromptChars:p.restartPromptChars,
  cumulativeRefinementChars:p.refinementChars,queuePeak:p.readerQueuePeak,fullQueueCount:p.readerFullQueueCount,
  cumulativeCompletedReaderSendUs:p.readerSendTotalUs,maxCompletedReaderSendUs:p.readerSendMaxUs,
  cumulativeCompletedCallbackUs:p.deltaCallbackTotalUs,maxCompletedCallbackUs:p.deltaCallbackMaxUs},
 scope:'Generic arithmetic over recorded checkpoint fields. Stage intervals describe this captured response only when their input timestamps are ordered; absent values remain null. RPC acknowledgment is separate and is not added to the stage sum. Receipt occurs in the shared stdout reader, so pre-receipt delay includes transport, provider activity and any preceding shared-reader blockage. Completed per-thread counters do not isolate an interval or exclude in-progress waits on other threads. Decoded-output delay does not isolate raw provider generation from framing or decoder execution. A live checkpoint requires final journal binding and independent accuracy review.',
 finalJournalBindingPending:true,independentAccuracyPending:true,goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,round:row.round,word:report.retainedVisibleWord,stagesMs:report.stagesMs,cleanupRelativeToPhysicalEndMs:report.cleanupRelativeToPhysicalEndMs,firstPostCleanupPrefixRelativeToPhysicalEndMs:report.firstPostCleanupPrefixRelativeToPhysicalEndMs,counters:report.counters}));
