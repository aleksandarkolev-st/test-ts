import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const report=JSON.parse(await readFile('artifacts/context-handoff/results.json','utf8'));
export function checkReservations(code){
 const results=[];
 const cases=[
  ['accepted and idempotent',s=>{const r=s.reserve('one',[{sku:'A',quantity:2}]);assert.equal(r.status,'accepted');assert.equal(s.reserve('one',[{sku:'A',quantity:2}]),r);assert.deepEqual(s.inventory(),{A:1,B:2});}],
  ['late insufficient item atomic',s=>{assert.throws(()=>s.reserve('one',[{sku:'A',quantity:1},{sku:'B',quantity:3}]));assert.deepEqual(s.inventory(),{A:3,B:2});const r=s.reserve('one',[{sku:'A',quantity:1}]);assert.equal(r.status,'accepted');}],
  ['duplicate sku aggregate atomic',s=>{assert.throws(()=>s.reserve('one',[{sku:'A',quantity:2},{sku:'A',quantity:2}]));assert.deepEqual(s.inventory(),{A:3,B:2});}],
  ['zero quantity atomic',s=>{assert.throws(()=>s.reserve('one',[{sku:'A',quantity:1},{sku:'B',quantity:0}]));assert.deepEqual(s.inventory(),{A:3,B:2});}],
  ['negative quantity atomic',s=>{assert.throws(()=>s.reserve('one',[{sku:'A',quantity:1},{sku:'B',quantity:-1}]));assert.deepEqual(s.inventory(),{A:3,B:2});}],
  ['fractional quantity atomic',s=>{assert.throws(()=>s.reserve('one',[{sku:'A',quantity:1},{sku:'B',quantity:0.5}]));assert.deepEqual(s.inventory(),{A:3,B:2});}],
  ['unknown sku atomic',s=>{assert.throws(()=>s.reserve('one',[{sku:'A',quantity:1},{sku:'missing',quantity:1}]));assert.deepEqual(s.inventory(),{A:3,B:2});}],
  ['duplicate sku accepted preserves items',s=>{const items=[{sku:'A',quantity:1},{sku:'A',quantity:2}];const r=s.reserve('one',items);assert.deepEqual(JSON.parse(JSON.stringify(r.items)),items);assert.deepEqual(s.inventory(),{A:0,B:2});}]
 ];
 for(const [name,check] of cases){
  try{
   const context=vm.createContext({});
   const inventory=`class Inventory {constructor(stock){this.stock=new Map(Object.entries(stock));} available(sku){return this.stock.get(sku)??0;} take(sku,n){if(this.available(sku)<n)throw Error('insufficient stock');this.stock.set(sku,this.available(sku)-n);} snapshot(){return Object.fromEntries(this.stock);} }`;
   vm.runInContext(`${inventory}\n${code.replace(/\bexport\s+(?=class\b)/g,'')}\nglobalThis.inventoryFixture=new Inventory({A:3,B:2});globalThis.fixture=new Reservations(inventoryFixture);`,context,{timeout:1500});
   const service={reserve:(id,items)=>{context.inputId=id;context.inputItems=structuredClone(items);return vm.runInContext('fixture.reserve(inputId,inputItems)',context,{timeout:1500});},inventory:()=>JSON.parse(JSON.stringify(vm.runInContext('inventoryFixture.snapshot()',context,{timeout:1500})))};
   check(service);results.push({name,passed:true});
  }catch(e){results.push({name,passed:false,error:String(e)});}
 }
 return {passed:results.every(r=>r.passed),results};
}
for(let i=0;i<report.interview.length;i++){
 const row=report.interview[i];if(i===0)continue;
 const code=[...row.answer.matchAll(/```(?:javascript|js)?\s*\n([\s\S]*?)```/g)].map(m=>m[1]).find(s=>/class Reservations/.test(s));
 row.implementationGrade=code?checkReservations(code):{passed:false,error:'No complete Reservations class returned'};
 if(code)await writeFile(`artifacts/context-handoff/interview-round-${i+1}.mjs`,code);
}
await writeFile('artifacts/context-handoff/results.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report.interview.map((r,i)=>({round:i+1,grade:r.implementationGrade})),null,2));
