import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
// Historical filename retained; reporting accepts any completed recording.
const [directory,output]=process.argv.slice(2);assert(directory&&output,'RECORDING_DIRECTORY OUTPUT_JSON');
const hash=x=>createHash('sha256').update(x).digest('hex'),auditFile=path.join(directory,'duration-audit.json'),raw=await readFile(auditFile),audit=JSON.parse(raw);
assert.equal(audit.status,'complete');assert(audit.stoppedCleanly);
const journalFile=directory+'/interview.json',journalHash=createHash('sha256');for await(const bytes of createReadStream(journalFile))journalHash.update(bytes);assert.equal(journalHash.digest('hex'),audit.journalSha256);
const rows=audit.rows.map(row=>({round:row.round,question:row.question,sourceQuestionSha256:hash(row.question),
 wordCount:(row.question.match(/[\p{L}\p{N}_]+/gu)??[]).length,
 otherAnswersStreamingAtPlaybackLaunch:row.otherAnswersStreamingAtPlaybackLaunch??[],immediateFollowup:row.immediateFollowup??null}));
const report={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:audit.journalSha256,status:audit.status,stoppedCleanly:audit.stoppedCleanly},
 evidence:{file:auditFile,sha256:hash(raw)},actualInterviewDurationMs:audit.actualInterviewDurationMs,recordedTurns:audit.rows.length,
 rows,actualStreamingOverlapLaunches:rows.filter(row=>row.otherAnswersStreamingAtPlaybackLaunch.length>0).length,
 scope:'Every actual source question and measured overlap is preserved without topic labels, round ranges or question-specific rules. Word counts are descriptive. Response correctness and latency require their separate source-bound measurements.',
 independentAccuracyPending:true,goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,recordedTurns:report.recordedTurns,actualStreamingOverlapLaunches:report.actualStreamingOverlapLaunches}));
