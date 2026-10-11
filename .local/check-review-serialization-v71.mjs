import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {serializeReviewInput} from './lib/serde-review-input.mjs';
const [journalFile,reviewFile,output]=process.argv.slice(2);
assert(journalFile&&reviewFile&&output);
const hash=value=>createHash('sha256').update(value).digest('hex');
const journalBytes=await readFile(journalFile),reviewBytes=await readFile(reviewFile);
const journal=JSON.parse(journalBytes),review=JSON.parse(reviewBytes),index=review.trial-1,row=journal.rows[index];
assert(row);
const input={answer:row.answer??null,cancelled:row.cancelled??null,error:row.error??null,phase:row.phase??null,
 publicPriorContext:row.selectedContext??null,recognizedQuestion:row.recognizedQuestion??null,
 sourcePriorQuestions:row.recordedSourcePriorQuestions??journal.rows.slice(0,index).map(prior=>({question:prior.question??null,round:prior.round??null})),spokenQuestion:row.question??null};
const canonical=hash(serializeReviewInput(input));
assert.equal(canonical,review.inputSha256,'Recursive serialization must match the actual reviewer input');
assert.notEqual(hash(JSON.stringify(input)),canonical,'This record must reproduce the prior binding failure');
const changed=structuredClone(input);changed.spokenQuestion+=' altered';
assert.notEqual(hash(serializeReviewInput(changed)),canonical,'Changed source values must still be rejected');
const record={recordedAt:new Date().toISOString(),status:'serialization_mismatch_isolated',
 journal:{file:journalFile,sha256:hash(journalBytes)},review:{file:reviewFile,sha256:hash(reviewBytes)},
 inputSha256:canonical,priorUnsortedSerializationSha256:hash(JSON.stringify(input)),
 priorSourceObjectKeyOrders:input.sourcePriorQuestions.map(prior=>Object.keys(prior)),
 sourceValuesChanged:false,recordingRepeated:false,judgmentChanged:false,
 changedSourceValueStillRejected:true,
 scope:'JavaScript insertion-order serialization differed from the reviewer serde_json recursively sorted object keys. Canonical serialization preserves all source values, fields and array order; no expected answer or verdict is inserted.'};
await writeFile(output,JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify(record));
