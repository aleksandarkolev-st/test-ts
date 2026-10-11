param([ValidateSet('algorithms','systems','general')][string]$Domain='algorithms',[double]$Minutes=60,[string]$Suffix='hour')
$ErrorActionPreference='Stop'
foreach($taskOption in @('COPILOT_NATIVE_INTERVIEW_CASE','COPILOT_NATIVE_INTERVIEW_SCENARIO','COPILOT_NATIVE_INTERVIEW_QUESTION_FILE','COPILOT_NATIVE_INTERVIEW_WAVE_FILE','COPILOT_NATIVE_INTERVIEW_REPLAY_DIR','COPILOT_NATIVE_INTERVIEW_REPLAY_PREFIX_ROUNDS','COPILOT_NATIVE_SKIP_REVIEW','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_NATIVE_RAPID','COPILOT_DEEP_REPLAY_FILE','COPILOT_INTENT_PROFILE','COPILOT_ACCEPTANCE_SELF_LOOPBACK','COPILOT_DEEP_SELF_OUTPUT')) {
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
$env:COPILOT_NATIVE_INTERVIEW_OUTPUT='artifacts/deep-interview-v70/'+$Domain+'-'+$Suffix
if(Test-Path -LiteralPath $env:COPILOT_NATIVE_INTERVIEW_OUTPUT){throw 'Refusing to overwrite recorded evidence'}
$env:COPILOT_NATIVE_INTERVIEW_MINUTES=[string]$Minutes
$env:COPILOT_NATIVE_INTERVIEW_ROUNDS='1000'
$env:COPILOT_DEEP_AUDIO='1'
$env:COPILOT_DEEP_OLDER_CODE_PROBE='1'
$env:COPILOT_NATIVE_INTERVIEW_AUDIO='1'
$env:COPILOT_ACCEPTANCE_REMOTE_ONLY='1'
$env:COPILOT_NATIVE_OUTPUT='T24E390'
$env:COPILOT_NATIVE_SPEECH_CHUNK_MS='160'
$env:COPILOT_NATIVE_ANSWER_MODEL='gpt-6.1-sol'
$env:COPILOT_NATIVE_ANSWER_EFFORT='low'
$env:COPILOT_INTERVIEW_EXAMINER_MODEL='gpt-6.1-sol'
$env:COPILOT_INTERVIEW_EXAMINER_EFFORT='low'
$env:COPILOT_NATIVE_REVIEW_ATTEMPTS='2'
$env:COPILOT_INTENT_MODE='existing'
$env:COPILOT_TRACE_PROVISIONAL='1'
$env:COPILOT_NEMO_DIAGNOSTICS='1'
$taskShared='Run a fresh full elapsed-time interview. Every next question must depend on the actual candidate answer. Include rapid terse contextual follow-ups such as Why? and What if that changes?, incomplete or incoherent references that require clarification, false starts, false premises, late constraint reversal, exact numbers and units, long multipart questions with crucial final conditions, and unrelated topic switches. Follow the delivery instructions, including 1.5-second mid-question pauses. After twenty or more turns refer precisely to an actual older implementation and change its constraints. Ask for valid executable code, explicit invariants, counterexample traces, overflow handling, complexity bounds and proofs. Move to a new difficult problem family after repeated errors. Keep questions natural and speakable, at most 120 spoken words. Do not use a fixed list or disclose private grading criteria.'
if($Domain -eq 'algorithms') {
 $taskDomain='Hard DSA interview: vary graphs and shortest paths, negative cycles, dynamic programming, streaming, heaps, hash tables, binary search boundaries, interval problems, union-find rollback, scheduling, trees, string algorithms and amortized analysis. Start with a fresh vague bug in an algorithm and require missing facts. Demand concrete Python or C++ implementations and testable edge cases. Include several unrelated database, networking or GPU switches before returning to earlier code.'
}elseif($Domain -eq 'systems') {
 $taskDomain='Broad systems interview: cover CUDA and GPU warps, reductions with partial participating lanes, divergent barriers, event-state semantics, exact floating-point arithmetic, highly skewed atomics-free histograms, launch arithmetic with non-power-of-two thread counts, database phantom reads and serializable isolation, Linux and Windows concurrency, RDMA, distributed retries, consensus, fencing and durable logs. Begin with an underspecified failure and develop facts from actual answers; keep varied families and exact executable reasoning.'
}else {
 $taskDomain='Broad interviews outside software: vary product management, business operations, marketing experiments, customer research, leadership and behavioral reasoning, negotiation, elementary economics, statistics, probability, causal inference, scientific experiment design and basic physics. Use hypothetical fully specified problems and fresh quantitative facts rather than time-sensitive real-company claims. Ask for concrete decisions, arithmetic, assumptions, counterexamples, experimental controls and uncertainty. Begin with a vague operational symptom and supply consistent public facts after clarification. Switch between unrelated subjects, revisit an earlier plan after constraints change, and demand exact references to previous figures or proposals. For every spoken question name signs, operators and units explicitly; avoid raw code tuples or symbolic formulas that speech synthesis might render ambiguously.'
}
$env:COPILOT_NATIVE_INTERVIEW_BRIEF=$taskDomain+' '+$taskShared
node scripts/native-signed-interview.mjs
$taskExit=$LASTEXITCODE
node scripts/summarize-deep-audio-duration.mjs $env:COPILOT_NATIVE_INTERVIEW_OUTPUT
if($LASTEXITCODE -ne 0){throw 'Measured run audit failed'}
exit $taskExit
