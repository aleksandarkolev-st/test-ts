param(
 [string]$EvidenceDirectory = ('artifacts/deep-audio-'+(Get-Date -Format 'yyyyMMdd-HHmmss')),
 [string]$PilotSuffix = 'pilot',
 [string]$ExistingGpuScenario = ''
)
$ErrorActionPreference='Stop'
$taskBase=$EvidenceDirectory
foreach ($taskOption in @('COPILOT_NATIVE_INTERVIEW_MINUTES','COPILOT_NATIVE_INTERVIEW_CASE','COPILOT_NATIVE_INTERVIEW_SCENARIO','COPILOT_NATIVE_INTERVIEW_REPLAY_DIR','COPILOT_NATIVE_INTERVIEW_QUESTION_FILE','COPILOT_NATIVE_INTERVIEW_WAVE_FILE','COPILOT_NATIVE_SKIP_REVIEW','COPILOT_NATIVE_RAPID','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_ACCEPTANCE_REMOTE_ONLY','COPILOT_INTENT_PROFILE','COPILOT_INTENT_BACKGROUND_IGNORE','COPILOT_DEEP_REPLAY_FILE')) {
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
$env:COPILOT_DEEP_AUDIO='1'
$env:COPILOT_NATIVE_INTERVIEW_AUDIO='1'
$env:COPILOT_NATIVE_INTERVIEW_ROUNDS='12'
$env:COPILOT_NATIVE_OUTPUT='T24E390'
$env:COPILOT_DEEP_SELF_OUTPUT='T24E390'
$env:COPILOT_NATIVE_SPEECH_CHUNK_MS='160'
$env:COPILOT_NATIVE_ANSWER_MODEL='gpt-6.1-sol'
$env:COPILOT_NATIVE_ANSWER_EFFORT='low'
$env:COPILOT_INTERVIEW_EXAMINER_MODEL='gpt-6.1-sol'
$env:COPILOT_INTERVIEW_EXAMINER_EFFORT='low'
$env:COPILOT_INTENT_MODE='existing'
$env:COPILOT_TRACE_PROVISIONAL='1'
$env:COPILOT_NEMO_DIAGNOSTICS='1'
$taskShared='Every follow-up must adapt to the actual preceding candidate answer. Progress from explanation into mechanisms, assumptions, edge cases, concrete executable code, counterexamples and debugging. Challenge unsupported claims. Include false premises, abrupt unrelated topic changes, short references, long multipart questions and decisive constraints or late negations at the end. Follow the per-round delivery instruction in the interview plan. Public questions must specify essential facts or deliberately request clarification. Ask natural speakable English with operators and identifiers named explicitly. Some follow-ups use a still-streaming actual answer prefix; do not assume unseen text. Do not repeat the same question after a recurring error; assess a new difficult family. Do not script a fixed list.'
$taskInterviews=@(
 @{name='gpu';brief='GPU programming: begin with an underspecified failure in a parallel reduction, then probe warp masks, memory ordering, divergent barriers, occupancy calculations, numerical reduction, stream dependencies and device faults. Demand exact CUDA C++ code or symbolic execution as appropriate.'},
 @{name='distributed';brief='Distributed systems: begin with an underspecified duplicate durable effect, then probe failure models, linearizability, consensus quorum intersections, durable logs, retries, deduplication, fencing, leases, clock uncertainty, partitions, reconfiguration and executable concurrent state-machine code.'},
 @{name='algorithms';brief='Algorithms: begin with an underspecified wrong shortest-path result, then probe negative edges and cycles, dynamic programming, streaming and amortized bounds, randomized structures, integer overflow, counterexample traces, proofs and exact executable algorithms.'}
)
foreach ($taskInterview in $taskInterviews) {
 $env:COPILOT_NATIVE_INTERVIEW_OUTPUT=$taskBase+'/'+$taskInterview.name+'-'+$PilotSuffix
 if ($taskInterview.name -eq 'gpu' -and $ExistingGpuScenario) { $env:COPILOT_NATIVE_INTERVIEW_SCENARIO=$ExistingGpuScenario }
 else { Remove-Item -LiteralPath Env:COPILOT_NATIVE_INTERVIEW_SCENARIO -ErrorAction SilentlyContinue }
 $env:COPILOT_NATIVE_INTERVIEW_BRIEF=$taskInterview.brief+' '+$taskShared
 if (Test-Path -LiteralPath $env:COPILOT_NATIVE_INTERVIEW_OUTPUT) { throw 'Refusing to overwrite recorded pilot' }
 Write-Output ('Starting adaptive '+$taskInterview.name+' pilot')
 & node scripts/native-signed-interview.mjs
 if ($LASTEXITCODE -ne 0) { throw ('Pilot failed: '+$taskInterview.name+'; evidence preserved') }
}
Write-Output 'All three adaptive pilots completed. Independent phrase grading and paired replays remain required.'
