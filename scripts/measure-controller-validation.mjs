import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {measureJournal} from './lib/controller-measurements.mjs';
const [journalFile,reviewFile,outputFile]=process.argv.slice(2);
assert(journalFile&&reviewFile&&outputFile,'JOURNAL REVIEW OUTPUT');
const bytes=await readFile(journalFile),review=JSON.parse(await readFile(reviewFile));
const sha=createHash('sha256').update(bytes).digest('hex');assert.equal(review.journalSha256,sha,'Reviews must bind the recorded answer bytes');
const journal=JSON.parse(bytes);assert.equal(journal.status,'complete');
await writeFile(outputFile,JSON.stringify({journalFile,journalSha256:sha,nativeBinarySha256:journal.nativeBinarySha256,
 backend:journal.backend??journal.variant,model:journal.model,effort:journal.effort,actualDurationMs:journal.actualInterviewDurationMs,
 ...measureJournal(journal,review)},null,2));
