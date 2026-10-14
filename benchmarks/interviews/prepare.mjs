import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {interviews} from './catalog.mjs';
import {bugs,checkBug} from './bugs.mjs';
const destination=path.resolve('.local/interview-suite/projects');await mkdir(destination,{recursive:true});
const manifest={status:'prepared_not_run',interviews:[],bugInterviews:[],note:'Catalog preparation is not evidence of completed live interviews. All 120 scenarios require native handoff, actual model responses, independent grades, and UI evidence.'};
for(const scenario of interviews){
 const folder=path.join(destination,scenario.id);await mkdir(folder,{recursive:true});
 await writeFile(path.join(folder,'TASK.md'),`# ${scenario.title}\n\n${scenario.task}\n\nContract: ${scenario.signature}. Return results, no stdin/stdout wrapper. No imports or exports in the solution.\n`);
 manifest.interviews.push({id:scenario.id,index:scenario.index,folder,rounds:scenario.rounds,gradeProvider:scenario.gradeProvider,status:'pending'});
}
for(const scenario of bugs){
 const folder=path.join(destination,`bug-${scenario.id}`);await mkdir(path.join(folder,'src'),{recursive:true});await mkdir(path.join(folder,'tests'),{recursive:true});
 const source=`export ${scenario.source}\n`;
 await writeFile(path.join(folder,'README.md'),`# ${scenario.title}\n\n${scenario.contract}\n\nPublic API: solve as exported by src/core.mjs. Preserve its argument order and synchronous return shape. Fix only source; no dependencies or test edits.\n`);
 await writeFile(path.join(folder,'package.json'),JSON.stringify({name:`interview-${scenario.id}`,private:true,type:'module',scripts:{test:'node --test tests/smoke.test.mjs'}}));
 await writeFile(path.join(folder,'src/core.mjs'),source);
 await writeFile(path.join(folder,'src/service.mjs'),`import {solve} from './core.mjs';\nexport function execute(...args){return solve(...args);}\n`);
 const args=scenario.cases[0],expected=scenario.oracle(...structuredClone(args));
 await writeFile(path.join(folder,'tests/smoke.test.mjs'),`import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {execute} from '../src/service.mjs';\ntest('public service smoke case',()=>assert.deepEqual(execute(...${JSON.stringify(args)}),${JSON.stringify(expected)}));\n`);
 manifest.bugInterviews.push({id:scenario.id,index:scenario.index,folder,rounds:scenario.rounds,sourceSha256:createHash('sha256').update(source).digest('hex'),defectControl:checkBug(scenario,scenario.source),status:'pending'});
}
await writeFile('benchmarks/interviews/prepared.json',JSON.stringify(manifest,null,2));
console.log(`Prepared ${manifest.interviews.length} different interview folders and ${manifest.bugInterviews.length} bug projects. Live runs: 0.`);
