import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='docs/evidence/architecture-systems-r3-checkpoint-v71.json',raw=await readFile(file),checkpoint=JSON.parse(raw),p=checkpoint.pipeline;
const prefix=(checkpoint.frameEvents??[]).filter(e=>e.name==='answer.provisional_prefix');
const preSend=prefix.filter(e=>e.payload.observedAt>=p.questionConfirmed&&e.payload.observedAt<p.latestInputSent);
const preReader=prefix.filter(e=>e.payload.observedAt>=p.latestInputSent&&e.payload.observedAt<p.latestInputReaderReceived);
const summarize=events=>({events:events.length,distinctQuestionFrames:[...new Set(events.map(e=>e.payload.question))],first:events[0]??null,last:events.at(-1)??null});
assert([p.questionConfirmed,p.latestInputSent,p.latestInputReaderReceived,p.latestInputConsumed,p.retainedFirstDelta,p.firstVisible].every(Number.isFinite));
const report={recordedAt:new Date().toISOString(),checkpoint:{file,sha256:createHash('sha256').update(raw).digest('hex')},
 round:checkpoint.round,responseVersion:checkpoint.responseVersion,word:checkpoint.firstStreamedWordMeasurement.firstVisibleStreamedWord,
 stages:{confirmationToFinalSendMs:p.latestInputSent-p.questionConfirmed,sentToMatchingReaderReceiptMs:p.latestInputReaderReceived-p.latestInputSent,
  readerToConsumerMs:p.latestInputConsumed-p.latestInputReaderReceived,consumerToRetainedDeltaMs:p.retainedFirstDelta-p.latestInputConsumed,
  retainedDeltaToNativeVisibleMs:p.firstVisible-p.retainedFirstDelta},
 pipeline:p,decodedPrefixActivity:{waitingToSubmitFinalInput:summarize(preSend),waitingForMatchingReaderReceipt:summarize(preReader)},
 conclusion:`The fresh systems tail recurs early with an initial caller prompt of ${p.promptChars} characters, a ${p.restartPromptChars}-character restart prompt and ${p.refinementChars} cumulative refinement characters. Long accumulated explicit context is not needed for this observed submission/receipt delay pattern. These counts do not include all instructions, wire encoding or reused native thread history. Per-thread reader receipt-to-consumer delay is ${p.latestInputConsumed-p.latestInputReaderReceived} ms, and ${p.readerFullQueueCount} full-queue sends were observed; the shared/provider-side interval remains unisolated.`,
 scope:'Immutable partial row snapshot from the live systems recording; final answer, word retention, cancellation and source binding require the clean completed journal. Decoded prefix observations show frame activity, not raw chunk ordering, complete output or semantic correctness.',
 independentAccuracyPending:true,finalJournalBindingPending:true,goalComplete:false};
const output='docs/evidence/systems-small-prompt-tail-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,stages:report.stages,prefixFramesBeforeSend:preSend.length,prefixFramesBeforeReader:preReader.length}));
