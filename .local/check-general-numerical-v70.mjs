// Deferred, source-bound finite checks, separate from whole-answer grading.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='artifacts/deep-interview-v70/general-hour-t/interview.json';
const bytes=await readFile(file),journal=JSON.parse(bytes);
assert(journal.status==='complete'&&journal.stoppedCleanly);
const hash=value=>createHash('sha256').update(value).digest('hex');
const rows=[4,7,31,32].map(round=>journal.rows.find(row=>row.round===round));
assert(rows.every(row=>row?.phase==='complete'&&!row.error));
const checks=[];
// These are the public hypothetical problem inputs in rounds 3 and 4,
// rather than expected answer values supplied to the candidate.
const inputs={demand:960,internalCapacity:600,vendorCapacity:300,contribution:12,
 fixedWages:960,vendorCost:5,latePenalty:6,minimumOnTimePercent:95,surcharge:2000};
function contribution(accepted,outsourced){
 const onTime=Math.min(accepted,inputs.internalCapacity+outsourced),late=accepted-onTime;
 const charge=100*onTime<inputs.minimumOnTimePercent*accepted?inputs.surcharge:0;
 return {accepted,outsourced,onTime,late,charge,
  contribution:accepted*inputs.contribution-inputs.fixedWages-outsourced*inputs.vendorCost-late*inputs.latePenalty-charge};
}
let greatestNoCharge=null,best=null,allocations=0;
for(let accepted=0;accepted<=inputs.demand;accepted++){
 for(let outsourced=0;outsourced<=Math.min(accepted,inputs.vendorCapacity);outsourced++){
  const value=contribution(accepted,outsourced);allocations++;
  if(value.charge===0&&(!greatestNoCharge||accepted>greatestNoCharge.accepted))greatestNoCharge=value;
  if(!best||value.contribution>best.contribution)best=value;
 }
}
const allAccepted=contribution(inputs.demand,inputs.vendorCapacity),answer4=rows[0].answer;
checks.push({round:4,kind:'exhaustive_integer_allocation_oracle',publicInputs:inputs,allocations,
 greatestNoCharge,best,maximumOutsourcingAllAccepted:allAccepted,
 observedClaims:{acceptanceCap:answer4.includes(`accept ${greatestNoCharge.accepted} orders`),
  capContribution:answer4.includes(`$${greatestNoCharge.contribution.toLocaleString('en-US')}`),
  allAcceptedContribution:answer4.includes(`$${allAccepted.contribution.toLocaleString('en-US')}`),
  gain:answer4.includes(`$${(greatestNoCharge.contribution-allAccepted.contribution).toLocaleString('en-US')}`)},
 scope:'Exact integer enumeration over the publicly bounded acceptance and outsourcing choices. Numerical claims are checked separately from leadership advice and complete-answer correctness.'});
const answer7=rows[1].answer;
const assignment=name=>BigInt(answer7.match(new RegExp(`^${name} = (\\d+)`,'mu'))?.[1]??assert.fail(`Missing ${name}`));
const capacity=assignment('capacity'),numerator=assignment('numerator'),denominator=assignment('denominator');
assert(capacity>=0n&&numerator>0n&&numerator<=denominator);
const exact=capacity*denominator/numerator;
const double=Number(capacity*denominator)/Number(numerator);assert(Number.isFinite(double));
const floating=BigInt(Math.trunc(double));
const declaredExact=BigInt(answer7.match(/Exact expected result: (\d+)/u)?.[1]??assert.fail('Missing exact result'));
const declaredFloating=BigInt(answer7.match(/Floating-point result: (\d+)/u)?.[1]??assert.fail('Missing floating result'));
checks.push({round:7,kind:'independent_binary64_counterexample_evaluation',capacity:String(capacity),
 numerator:String(numerator),denominator:String(denominator),exact:String(exact),floating:String(floating),
 claimedExactMatches:declaredExact===exact,claimedFloatingMatches:declaredFloating===floating,
 counterexampleActuallyDiffers:exact!==floating,
 scope:'The supplied counterexample operands are evaluated with BigInt exact arithmetic and an independent JavaScript binary64 conversion/division. This does not execute the Python listing or certify every input.'});
function powmod(base,exponent,modulus){
 let result=1n,n=BigInt(modulus),value=BigInt(base)%n,e=BigInt(exponent);
 while(e){if(e&1n)result=result*value%n;value=value*value%n;e>>=1n;}
 return Number(result);
}
for(const [row,modulus,exponents,ciphertexts] of [[rows[2],55,[3,7],[15,25]],[rows[3],91,[3,9],[8,57]]]){
 const possible=Array.from({length:modulus},(_,message)=>message).filter(message=>
  exponents.every((exponent,index)=>powmod(message,exponent,modulus)===ciphertexts[index]));
 const claimed=row.round===31?[Number(row.answer.match(/unique message is (\d+)/u)?.[1]??assert.fail('Missing claimed message'))]:
  [...(row.answer.match(/messages are possible: ([^.]+)\./u)?.[1]??assert.fail('Missing claimed list')).matchAll(/\d+/gu)].map(match=>Number(match[0]));
 checks.push({round:row.round,kind:'exhaustive_finite_message_oracle',publicInputs:{modulus,exponents,ciphertexts},
  messagesEnumerated:modulus,possibleMessages:possible,claimedMessages:claimed,
  claimedListMatchesEverySolution:JSON.stringify(claimed)===JSON.stringify(possible),
  scope:'Every message in the requested finite domain is tested against both equations, using independent modular exponentiation. The candidate CRT construction is not used as the oracle. This verifies these finite examples, not a general cryptographic attack or every prose claim.'});
}
const report={recordedAt:new Date().toISOString(),journal:{file,sha256:hash(bytes)},
 sourceRows:rows.map(row=>({round:row.round,question:row.question,questionSha256:hash(row.question),answerSha256:hash(row.answer)})),
 checks,productionLogicChanged:false,
 scope:'Selected independently computed numerical checks of completed retained answers. Original recording and answer text are unchanged. Hypothetical source inputs are oracle inputs only; no expected answer was supplied to the candidate. Results remain separate from all-turn model verdicts and untested claims.'};
await writeFile('docs/evidence/general-numerical-checks-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({checks:checks.map(({round,kind,observedClaims,claimedExactMatches,claimedFloatingMatches,counterexampleActuallyDiffers,claimedListMatchesEverySolution})=>
 ({round,kind,observedClaims,claimedExactMatches,claimedFloatingMatches,counterexampleActuallyDiffers,claimedListMatchesEverySolution}))}));
