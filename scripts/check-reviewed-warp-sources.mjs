// Prepared now; execution is forbidden until BOTH live queues are complete.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const journalFile=process.argv[2],specFile=process.argv[3],out=process.argv[4];
assert(journalFile&&specFile&&out);
const sha=x=>createHash('sha256').update(x).digest('hex');
for(const file of ['artifacts/controller-v73/reliability-live-r1/verification.json','artifacts/controller-v73/reliability-controls-r1/verification.json'])
    assert.equal(JSON.parse(await readFile(file)).status,'complete_pending_manual_review','No fixture or model source compilation during live capture');
const probe="$ErrorActionPreference='Stop'; $ownedMatches=@(Get-CimInstance Win32_Process -Filter \"Name = 'wavesSvc64.exe' OR Name = 'nemo-speech.exe'\" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\controller-',[System.StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\nemotron\\',[System.StringComparison]::OrdinalIgnoreCase)) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $ownedMatches -Compress; exit 0";
assert.equal(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',probe],{windowsHide:true,encoding:'utf8'}).trim(),'[]','Owned native/ASR still active');
const jb=await readFile(journalFile),j=JSON.parse(jb),sb=await readFile(specFile),spec=JSON.parse(sb);
assert(j.status==='complete'&&j.stoppedCleanly);assert.equal(sha(jb),spec.journalSha256);
const hb=await readFile('scripts/fixtures/cuda-warp-contract-harness-v73.hpp');
await mkdir(out);
await writeFile(path.join(out,'cuda-warp-contract-harness.hpp'),hb);
await writeFile(path.join(out,'cuda_runtime.h'),'#include "cuda-warp-contract-harness.hpp"\n');
const cases=[];let state=0x61d0c0de;
const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
cases.push(Array(32).fill(1),Array(32).fill(0));
for(let lane=0;lane<32;++lane)cases.push(Array.from({length:32},(_,i)=>i===lane?1:0));
cases.push(Array.from({length:32},(_,i)=>i%2?-4095:4095));
for(let i=0;i<64;++i)cases.push(Array.from({length:32},()=>next()%8191-4095));
const fixture=Buffer.from(JSON.stringify(cases));await writeFile(path.join(out,'inputs.json'),fixture);
const report={startedAt:new Date().toISOString(),journal:{file:journalFile,sha256:sha(jb)},spec:{file:specFile,sha256:sha(sb)},checkerSha256:sha(await readFile(new URL(import.meta.url))),harnessSha256:sha(hb),fixtureSha256:sha(fixture),results:[],scope:'Unchanged individually reviewed actual width32 CUDA device functions executed through a generic CPU intrinsic contract shim. Variable participant masks and a full32 ballot are supported. Bounded integer inputs make allowed sums exactly representable. Named callers, matching instances, source membership, returned values and declared shuffle budgets checked; not NVIDIA hardware, independent scheduling, GPU memory fences or FTZ certification. No fixture/oracle enters production generation.'};
const persist=()=>writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2)+'\n');
report.status='executing';
await persist();
const run=(file,args,budget)=>new Promise(resolve=>{let stdout='',stderr='',timedOut=false;const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{timedOut=true;child.kill();},budget);child.stdout.on('data',d=>stdout=(stdout+d).slice(-200000));child.stderr.on('data',d=>stderr=(stderr+d).slice(-20000));child.once('error',e=>{clearTimeout(timer);resolve({error:String(e),stdout,stderr,timedOut});});child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut});});});
for(const check of spec.checks){
    assert(['source-broadcast','sum'].includes(check.kind));
    assert(/^[A-Za-z_]\w*$/.test(check.functionName));
    assert(Array.isArray(check.callerLanes)&&check.callerLanes.length&&new Set(check.callerLanes).size===check.callerLanes.length&&check.callerLanes.every(l=>Number.isInteger(l)&&l>=0&&l<32));
    assert(Number.isInteger(check.maximumShuffleCalls)&&check.maximumShuffleCalls>0);
    const rb=await readFile(check.reviewFile),review=JSON.parse(rb),row=review.rows.find(r=>r.round===check.round),actual=j.rows.find(r=>r.round===check.round);
    assert(row&&actual);assert.equal(sha(actual.answer),row.answerSha256);assert.equal(sha(rb),check.reviewSha256);
    const blocks=[...actual.answer.matchAll(/```(?:cpp|cuda)\r?\n([\s\S]*?)```/g)];
    const code=blocks[check.codeIndex??0]?.[1];assert(code,'Actual source fence required');
    const initializer=cases.map(c=>'{{'+c.join(',')+'}}').join(',\n');
    const main=`\n#include <iostream>\n#include <iomanip>\nint main(){try{\nconst std::array<std::array<int,32>,${cases.length}> inputs={{${initializer}}};\nconst std::vector<unsigned> callers={${check.callerLanes.join(',')}};\nstd::cout<<std::fixed<<std::setprecision(0);\nfor(unsigned probe=0;probe<inputs.size();++probe){\ncollective.reset(${check.simulatedActiveMask??'0xffffffffu'},${check.maximumShuffleCalls});\nstd::array<float,32> output{};std::array<unsigned,32> counts{};\nstd::array<std::exception_ptr,32> errors{};std::vector<std::thread> threads;\nfor(unsigned lane:callers)threads.emplace_back([&,lane]{threadIdx={lane,0,0};collective_step=shuffle_count=0;try{output[lane]=${check.functionName}(static_cast<float>(inputs[probe][lane]));counts[lane]=shuffle_count;}catch(...){errors[lane]=std::current_exception();}});\nfor(auto& t:threads)t.join();for(auto e:errors)if(e)std::rethrow_exception(e);\nstd::cout<<probe;for(unsigned lane:callers)std::cout<<' '<<output[lane]<<' '<<counts[lane];std::cout<<'\\n';\n}}catch(const std::exception& e){std::cerr<<e.what();return 2;}}\n`;
    const source='#include "cuda-warp-contract-harness.hpp"\n'+code+main,stem='round-'+check.round+'-'+check.kind,sourceFile=path.resolve(out,stem+'.cpp'),exe=path.resolve(out,stem+'.exe');
    await writeFile(sourceFile,source);
    const result={...check,answerSha256:sha(actual.answer),codeSha256:sha(code),harnessedSourceSha256:sha(source),algorithmRepaired:false};report.results.push(result);
    result.compile=await run('clang++',['-std=c++17','-O0','-fno-fast-math','-I',path.resolve(out),sourceFile,'-o',exe],20000);
    if(result.compile.error){
        result.executionVerdict='infrastructure_failure';
        report.status='failed_infrastructure';report.failure=result.compile.error;
        report.completedAt=new Date().toISOString();await persist();
        throw Error('Compiler spawn failed; no model verdict: '+result.compile.error);
    }
    if(result.compile.code===0&&!result.compile.timedOut){
        result.execution=await run(exe,[],60000);
        if(result.execution.error){
            result.executionVerdict='infrastructure_failure';
            report.status='failed_infrastructure';report.failure=result.execution.error;
            report.completedAt=new Date().toISOString();await persist();
            throw Error('Recorded executable spawn failed; no model verdict: '+result.execution.error);
        }
        if(result.execution.code===0&&!result.execution.timedOut){
            const lines=result.execution.stdout.trim().split(/\r?\n/);result.outputRows=lines.length;result.cases=[];
            for(let i=0;i<lines.length;i++){
                const parts=lines[i].trim().split(/\s+/),expectedSum=check.kind==='sum'?check.callerLanes.reduce((s,l)=>s+BigInt(cases[i]?.[l]??0),0n):null;
                const comparisons=check.callerLanes.map((lane,n)=>{
                    const isParticipant=(check.resultLanes??check.callerLanes).includes(lane),expected=check.kind==='sum'?expectedSum.toString():String(cases[i]?.[isParticipant?check.sourceLane:lane]);
                    const actual=parts[1+2*n],shuffles=Number(parts[2+2*n]),required=check.exactShuffleCallsByLane?.[lane];
                    return {lane,expected,actual,shuffles,pass:actual===expected&&Number.isInteger(shuffles)&&shuffles<=check.maximumShuffleCalls&&(required==null||shuffles===required)};
                });
                result.cases.push({index:i,pass:i<cases.length&&parts[0]===String(i)&&parts.length===1+2*check.callerLanes.length&&comparisons.every(c=>c.pass),comparisons});
            }
        }
    }
    result.pass=result.compile.code===0&&!result.compile.timedOut&&result.execution?.code===0&&!result.execution.timedOut&&result.outputRows===cases.length&&result.cases.every(c=>c.pass);
    result.executionVerdict=result.pass?'finite_contract_pass':'finite_contract_fail';
    await persist();
}
report.status='complete_pending_manual_review';report.completedAt=new Date().toISOString();await persist();
console.log(JSON.stringify({out,results:report.results.map(r=>({round:r.round,kind:r.kind,pass:r.pass,compile:r.compile.code,execution:r.execution?.code,inputVectors:cases.length}))}));
