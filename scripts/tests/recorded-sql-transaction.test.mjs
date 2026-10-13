import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedSqlTransaction,recordedSqlProgram,repeatableReadControlBegin} from '../lib/recorded-sql-transaction.mjs';
test('comments and procedural bodies survive unchanged scheduling boundaries',()=>{
 const source='-- Alice\nBEGIN ISOLATION LEVEL SERIALIZABLE;\nDO $$ BEGIN PERFORM 1; END; $$;\nCOMMIT; -- end\n';
 const parts=recordedSqlTransaction(source);assert(parts);
 assert.equal(parts.begin+parts.body+parts.commit,source);
 assert(parts.body.includes('DO $$ BEGIN PERFORM 1; END; $$;'));
});
test('repeatable-read control changes actual isolation, not a comment',()=>{
 const begin='-- ISOLATION LEVEL SERIALIZABLE\nBEGIN /* SERIALIZABLE */ ISOLATION LEVEL SERIALIZABLE;';
 assert.equal(repeatableReadControlBegin(begin),'-- ISOLATION LEVEL SERIALIZABLE\nBEGIN /* SERIALIZABLE */ ISOLATION LEVEL REPEATABLE READ;');
 assert.equal(repeatableReadControlBegin('BEGIN;'),null);
});
test('extra executable statements outside the transaction are unsupported',()=>{
 assert.equal(recordedSqlTransaction('SELECT 1; BEGIN; SELECT 2; COMMIT;'),null);
 assert.equal(recordedSqlTransaction('BEGIN; SELECT 1; COMMIT; DROP TABLE doctors;'),null);
 assert.equal(recordedSqlTransaction('BEGIN; SELECT 1;'),null);
});
test('a comment cannot masquerade as a COMMIT and comment semicolons cannot split BEGIN',()=>{
 assert.equal(recordedSqlTransaction('BEGIN; SELECT 1; -- COMMIT;'),null);
 const source='/* nested /* ; */ comment */ BEGIN /* ; */ ISOLATION LEVEL SERIALIZABLE;\nSELECT $$COMMIT;$$, \'semicolon;\';\nCOMMIT;';
 const parts=recordedSqlTransaction(source);assert(parts);assert.equal(parts.begin+parts.body+parts.commit,source);
 assert(parts.begin.includes('ISOLATION LEVEL SERIALIZABLE;'));assert(parts.body.includes('SELECT $$COMMIT;$$'));
});

test('single-fence setup and concurrent transaction sources preserve every byte',()=>{
 const source='-- setup\nCREATE TABLE items (id int);\n-- first\nBEGIN ISOLATION LEVEL SERIALIZABLE;\nDO $$ BEGIN PERFORM \'COMMIT;\'; END; $$;\nCOMMIT;\n-- second\nBEGIN ISOLATION LEVEL SERIALIZABLE;\nSELECT 2;\nCOMMIT; -- trailing\n';
 const program=recordedSqlProgram(source);assert(program);assert.equal(program.transactions.length,2);
 assert.equal(program.setup+program.transactions.join(''),source);
 for(const transaction of program.transactions)assert(recordedSqlTransaction(transaction));
});

test('ambiguous, nested and incomplete single-fence transactions are rejected',()=>{
 for(const source of ['BEGIN; SELECT 1;','BEGIN; BEGIN; SELECT 1; COMMIT; COMMIT;','CREATE TABLE x(id int); COMMIT;','BEGIN; SELECT 1; COMMIT; DROP TABLE x;','BEGIN; SELECT 1; COMMIT; SELECT 2; BEGIN; SELECT 3; COMMIT;'])assert.equal(recordedSqlProgram(source),null);
});
