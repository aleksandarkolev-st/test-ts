import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32c,logRecord,logRecoveryFixtures} from '../lib/log-recovery-fixtures.mjs';
test('CRC-32C check vector and original encoded sequence coverage',()=>{
 assert.equal(crc32c(Buffer.from('123456789')),0xe3069283);
 const record=logRecord(0x0102030405060708n,Buffer.from([255,0]));
 assert.equal(record.readBigUInt64LE(4),0x0102030405060708n);
 assert.equal(record.readUInt32LE(record.length-4),crc32c(record.subarray(4,-4)));
 assert.notEqual(record.readUInt32LE(record.length-4),crc32c(record.subarray(0,-4)));
});
test('every small truncation retains only complete record boundaries',()=>{
 const fixtures=logRecoveryFixtures(),valid=fixtures.find(f=>f.name==='three-valid-including-empty-payload').bytes;
 const boundaries=[0,21,37,56];
 assert.equal(valid.length,56);
 for(const fixture of fixtures.filter(f=>f.name.startsWith('truncated-at-')))
  assert.equal(fixture.offset,boundaries.filter(b=>b<=fixture.bytes.length).at(-1));
 for(const fixture of fixtures.filter(f=>f.name.startsWith('damaged-')))
  assert.equal(fixture.offset,37,'A later plausible record cannot authorize resynchronization');
});
