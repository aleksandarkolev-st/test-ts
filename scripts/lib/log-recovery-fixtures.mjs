// Independent byte-level fixtures for the supplied-CRC recovery contract.
import assert from 'node:assert/strict';
export function crc32c(bytes){
 let value=0xffffffff;
 for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0x82f63b78:0);}
 return (value^0xffffffff)>>>0;
}
export function logRecord(sequence,payload){
 const header=Buffer.alloc(12);header.writeUInt32LE(payload.length);header.writeBigUInt64LE(BigInt(sequence),4);
 const checksum=Buffer.alloc(4);checksum.writeUInt32LE(crc32c(Buffer.concat([header.subarray(4),payload])));
 return Buffer.concat([header,payload,checksum]);
}
export function logRecoveryFixtures(){
 assert.equal(crc32c(Buffer.from('123456789')),0xe3069283,'Standard CRC-32C check vector');
 const first=logRecord(0,Buffer.from('alpha')),second=logRecord(1,Buffer.alloc(0)),third=logRecord(2,Buffer.from([0,255,7]));
 const valid=Buffer.concat([first,second,third]);
 const fixtures=[{name:'empty',bytes:Buffer.alloc(0),offset:0},{name:'three-valid-including-empty-payload',bytes:valid,offset:valid.length}];
 for(let end=1;end<valid.length;end++)fixtures.push({name:'truncated-at-'+end,bytes:valid.subarray(0,end),offset:end>=first.length+second.length?first.length+second.length:end>=first.length?first.length:0});
 for(const [name,index] of [['length',0],['sequence',4],['payload',12],['checksum',third.length-1]]){
  const damaged=Buffer.from(third);damaged[index]^=0x80;
  fixtures.push({name:'damaged-'+name+'-then-plausible-record',bytes:Buffer.concat([first,second,damaged,logRecord(2,Buffer.from('later'))]),offset:first.length+second.length});
 }
 for(const [name,sequence] of [['gap',2],['duplicate',0],['huge-sequence',0xffffffffffffffffn]])fixtures.push({name,bytes:Buffer.concat([first,logRecord(sequence,Buffer.from('x')),second]),offset:first.length});
 const tooLarge=Buffer.alloc(12);tooLarge.writeUInt32LE(1024*1024+1);tooLarge.writeBigUInt64LE(1n,4);
 fixtures.push({name:'over-cap-header',bytes:Buffer.concat([first,tooLarge,second]),offset:first.length});
 const maximum=logRecord(0,Buffer.alloc(1024*1024,0xa5));
 fixtures.push({name:'maximum-payload',bytes:maximum,offset:maximum.length});
 fixtures.push({name:'maximum-payload-torn-checksum',bytes:maximum.subarray(0,maximum.length-1),offset:0});
 fixtures.push({name:'initial-sequence-must-be-zero',bytes:logRecord(1,Buffer.alloc(0)),offset:0});
 return fixtures;
}
export const suppliedCrc32cSource=`
#include <span>
#include <cstddef>
#include <cstdint>
std::uint32_t crc32c(const std::uint8_t* data, std::size_t size) {
    std::uint32_t value = 0xffffffffu;
    for (std::size_t i = 0; i < size; ++i) {
        value ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            value = (value >> 1) ^ ((value & 1u) ? 0x82f63b78u : 0u);
    }
    return value ^ 0xffffffffu;
}
std::uint32_t crc32c(std::span<const std::byte> bytes) {
    return crc32c(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}
`;
