import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const original=JSON.parse(await readFile('artifacts/deep-interview-v71/preparation.json'));
const files=['.local/run-recordings-v71.ps1','.local/run-deep-hour-v71.ps1','.local/run-hard-probes-v71.ps1','.local/run-continuous-pressure-v71.ps1','.local/run-midpoint-pause-v71.ps1','.local/prepare-midpoint-pause-v71.mjs','.local/observe-pressure-events-v71.mjs','.local/run-assessments-v71.ps1','.local/analyze-architecture-v71.mjs','.local/inspect-live-architecture-v71.mjs','.local/prepare-pressure-review-v71.mjs','.local/audit-pressure-clauses-v71.mjs','.local/audit-pressure-drift-v71.mjs','.local/audit-pressure-visibility-v71.mjs'];
const sources=await Promise.all(files.map(async file=>{const raw=await readFile(file),prior=original.sources.find(s=>s.file===file);return {file,sha256:hash(raw),preparationSha256:prior?.sha256??null,changedSincePreparation:prior?hash(raw)!==prior.sha256:null};}));
const report={recordedAt:new Date().toISOString(),sources,
 revisionScope:'The future continuous-pressure launcher now includes the independently prepared measured midpoint-pause case and a read-only native event sidecar. These helper changes were made before that launcher executes. The three-hour candidate runner, native executable, model settings and production response behavior are unchanged.',
 recordingOwner:{processId:24692,creationHostMs:1791700501977,execSessionId:45537,identityVerifiedAt:'2026-10-11T06:44Z',currentDomain:'general'},
 deferredAssessmentCommand:'.\\.local\\run-assessments-v71.ps1',deferredAssessmentNotStarted:true,
 note:'Do not rerun the recording launcher while its session/process is live. The new full suite and deferred accuracy, source-bound architecture audit, code checks and final completion audit remain pending.',goalComplete:false};
await writeFile('artifacts/deep-interview-v71/orchestration-revision.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'artifacts/deep-interview-v71/orchestration-revision.json',changed:sources.filter(s=>s.changedSincePreparation===true).map(s=>s.file)}));
