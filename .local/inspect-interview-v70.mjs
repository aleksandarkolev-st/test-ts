import {readFile} from 'node:fs/promises';
const file=process.argv[2]??'artifacts/deep-interview-v70/hard-probes/deep-code-memory/interview.json';
const journal=JSON.parse(await readFile(file));
console.log(JSON.stringify({status:journal.status,startedAt:journal.startedAt,roundCount:journal.rows.length,planned:journal.rounds,
 stoppedCleanly:journal.stoppedCleanly,olderCodeProbe:journal.olderCodeProbe,output:journal.outputDevice,
 memory:journal.recorderResources?.at(-1),pollErrors:journal.pollErrors?.length}));
for(const row of journal.rows)console.log(JSON.stringify({round:row.round,question:row.question,phase:row.phase,
 answerChars:row.answer?.length,responseVersion:row.responseVersion,cancelled:row.cancelled,grade:row.review?.verdict}));
