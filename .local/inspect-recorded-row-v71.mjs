import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [file,roundText,...fields]=process.argv.slice(2);
assert(file&&roundText&&fields.length,'JOURNAL ROUND FIELD...');
const journal=JSON.parse(await readFile(file)),row=journal.rows.find(row=>row.round===Number(roundText));
assert(row,'Recorded round missing');
console.log(JSON.stringify(Object.fromEntries(fields.map(field=>[field,row[field]??null])),null,2));
