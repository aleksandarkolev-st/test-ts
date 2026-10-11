import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fencedSources} from './lib/fenced-sources.mjs';
const directory=process.argv[2];assert(directory,'RECORDING_DIRECTORY');
const file=path.join(directory,'interview.json'),bytes=await readFile(file),journal=JSON.parse(bytes);
assert(journal.status==='complete'&&journal.stoppedCleanly,'Require a clean completed recording');
const hash=value=>createHash('sha256').update(value).digest('hex'),probe=journal.olderCodeProbe;
if(!probe){console.log(JSON.stringify({file,automaticOlderCodeProbeRecorded:false}));process.exit(0);}
assert.equal(hash(probe.sourceAnswer),probe.sourceAnswerSha256,'Recorded reference answer changed');
const sourceIndex=journal.rows.findIndex(row=>row.round===probe.sourceRound),probeIndex=journal.rows.findIndex(row=>row.round===probe.probeRound);
assert(sourceIndex>=0);const original=journal.rows[sourceIndex],response=probeIndex>=0?journal.rows[probeIndex]:null;
assert.equal(original.question,probe.sourceQuestion);
if(response)assert.equal(response.question,probe.text,'Spoken probe differs from recorded reference request');
const referenceBlocks=fencedSources(probe.sourceAnswer),responseBlocks=fencedSources(response?.answer??'');
const blocks=referenceBlocks.map((block,index)=>({index,languageAnnotation:block.languageAnnotation,codeSha256:hash(block.text),codeCharacters:block.text.length,
 exactlyReproducedInResponse:responseBlocks.some(candidate=>candidate.text===block.text),
 reproducedAfterLineEndingAndOuterWhitespaceNormalization:responseBlocks.some(candidate=>candidate.text.replace(/\r\n/g,'\n').trim()===block.text.replace(/\r\n/g,'\n').trim())}));
const interveningTurns=probeIndex>=0?probeIndex-sourceIndex-1:null;
const report={recordedAt:new Date().toISOString(),journal:{file,sha256:hash(bytes),status:journal.status,stoppedCleanly:journal.stoppedCleanly},
 model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 recordedReference:{sourceRound:probe.sourceRound,sourceResponseVersion:probe.sourceResponseVersion,sourceAnswerSha256:probe.sourceAnswerSha256,sourceQuestionSha256:hash(probe.sourceQuestion),
  finalSourceResponseVersion:original.responseVersion,finalSourceAnswerSha256:hash(original.answer??''),
  recordedReferenceMatchesFinalSourceAnswer:hash(original.answer??'')===probe.sourceAnswerSha256,
  recordedReferenceMatchesFinalSourceVersion:original.responseVersion===probe.sourceResponseVersion},
 probe:{round:probe.probeRound,spokenQuestion:probe.text,spokenQuestionSha256:hash(probe.text),delivered:response!==null,
  interveningTurns,recordedPlannedInterveningTurns:probe.interveningTurns,atLeastTwentyInterveningTurns:interveningTurns===null?null:interveningTurns>=20,
  responseVersion:response?.responseVersion??null,answerSha256:response?hash(response.answer??''):null,phase:response?.phase??null,
  cancelled:response?.cancelled??null,error:response?.error??null,answerCharacters:response?.answer?.length??null,
  responseFencedBlocks:responseBlocks.map(block=>({languageAnnotation:block.languageAnnotation,codeSha256:hash(block.text),codeCharacters:block.text.length}))},
 referenceBlocks:blocks,collectorSourceHashes:{'scripts/audit-older-code-reference.mjs':hash(await readFile(new URL(import.meta.url))),'scripts/lib/fenced-sources.mjs':hash(await readFile(new URL('./lib/fenced-sources.mjs',import.meta.url)))},
 scope:'Version and delivery audit of the actually recorded automatic older-code reference. Intervening turns are counted from recorded row positions. Reference and response code remain untouched. Literal code reproduction, limited formatting equality, and final-source-version identity are descriptive facts; they do not determine semantic correctness, clarification quality, contract preservation or memory-test success. Missing, cancelled and erroneous responses remain explicit. Independent review and substantive code checks remain separate.',
 semanticRetentionAccuracyCertified:false,goalComplete:false};
const output=path.join(directory,'older-code-reference-audit.json');await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,sourceRound:probe.sourceRound,probeRound:probe.probeRound,probeDelivered:response!==null,interveningTurns,phase:response?.phase??null,referenceBlocks:blocks}));
