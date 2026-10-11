$ErrorActionPreference='Stop'
$taskQueue=Get-Content -LiteralPath 'artifacts/deep-interview-v70/remaining-runs.jsonl' -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskQueue.event -ne 'scheduled_playback_runs_finished'){throw 'Finish the scheduled measured recordings first'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'scripts/native-signed-interview.mjs' }
if($taskLive){throw 'Refusing to overlap native interview recordings'}
$taskOutput='artifacts/deep-interview-v70/hard-probes/long-question-essential-tail-midpoint-pause'
if(Test-Path -LiteralPath $taskOutput){throw 'Refusing to overwrite midpoint-pause recording'}
foreach($taskOption in @('COPILOT_NATIVE_INTERVIEW_MINUTES','COPILOT_NATIVE_INTERVIEW_CASE','COPILOT_NATIVE_INTERVIEW_QUESTION_FILE','COPILOT_NATIVE_INTERVIEW_WAVE_FILE','COPILOT_NATIVE_INTERVIEW_REPLAY_DIR','COPILOT_NATIVE_INTERVIEW_REPLAY_PREFIX_ROUNDS','COPILOT_NATIVE_SKIP_REVIEW','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_NATIVE_RAPID','COPILOT_DEEP_REPLAY_FILE','COPILOT_INTENT_PROFILE','COPILOT_ACCEPTANCE_SELF_LOOPBACK','COPILOT_DEEP_SELF_OUTPUT')){
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
$env:COPILOT_NATIVE_INTERVIEW_OUTPUT=$taskOutput
$env:COPILOT_NATIVE_INTERVIEW_SCENARIO='artifacts/deep-interview-v70/midpoint-pause-preparation/scenario.json'
$env:COPILOT_NATIVE_INTERVIEW_ROUNDS='1'
$env:COPILOT_DEEP_AUDIO='1'
$env:COPILOT_DEEP_OLDER_CODE_PROBE='0'
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
$env:COPILOT_NATIVE_INTERVIEW_BRIEF='Record the provided public question with its measured midpoint pause and essential final condition. Preserve all observed timing, ASR, job revisions and actual painted answers for independent review.'
node scripts/native-signed-interview.mjs
if($LASTEXITCODE -ne 0){throw 'Midpoint-pause recording failed; preserve evidence'}
node scripts/summarize-deep-audio-duration.mjs $taskOutput
if($LASTEXITCODE -ne 0){throw 'Midpoint-pause metric audit failed'}
