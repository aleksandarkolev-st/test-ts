param([string]$Suffix='t')
$ErrorActionPreference='Stop'
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'scripts/native-signed-interview.mjs' }
if($taskLive){throw 'Refusing to overlap measured audio interviews'}
if(Test-Path -LiteralPath ('artifacts/deep-interview-v70/continuous-pressure-'+$Suffix)){throw 'Refusing to overwrite pressure evidence'}
# The original SSML pause cases are preserved. These strict waveform variants
# run serially before the uninterrupted pressure track starts.
foreach($taskPauseCase in @('histogram-late-reversal','long-question-essential-tail')){
 $taskPauseDirectory='artifacts/deep-interview-v70/hard-probes/'+$taskPauseCase+'-exact-pause'
 if(Test-Path -LiteralPath $taskPauseDirectory){
  $taskPauseAudit=Get-Content -LiteralPath ($taskPauseDirectory+'/duration-audit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($taskPauseAudit.status -ne 'complete' -or $taskPauseAudit.stoppedCleanly -ne $true){throw 'Existing exact-pause probe is not clean and complete'}
 }else{
  & .\.local\run-hard-probes-v70.ps1 -Cases $taskPauseCase -Suffix exact-pause -ExactDigitalPause
  if($LASTEXITCODE -ne 0){throw 'Exact digital pause probe failed; preserve and inspect it'}
 }
}
foreach($taskOption in @('COPILOT_NATIVE_INTERVIEW_MINUTES','COPILOT_NATIVE_INTERVIEW_CASE','COPILOT_NATIVE_INTERVIEW_QUESTION_FILE','COPILOT_NATIVE_INTERVIEW_WAVE_FILE','COPILOT_NATIVE_INTERVIEW_REPLAY_DIR','COPILOT_NATIVE_INTERVIEW_REPLAY_PREFIX_ROUNDS','COPILOT_NATIVE_SKIP_REVIEW','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_NATIVE_RAPID','COPILOT_DEEP_REPLAY_FILE','COPILOT_INTENT_PROFILE','COPILOT_ACCEPTANCE_SELF_LOOPBACK','COPILOT_DEEP_SELF_OUTPUT')) {
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
$env:COPILOT_NATIVE_INTERVIEW_OUTPUT='artifacts/deep-interview-v70/continuous-pressure-'+$Suffix
if(Test-Path -LiteralPath $env:COPILOT_NATIVE_INTERVIEW_OUTPUT){throw 'Refusing to overwrite pressure evidence'}
$env:COPILOT_NATIVE_INTERVIEW_SCENARIO='tests/fixtures/continuous-interview-pressure.json'
$env:COPILOT_NATIVE_INTERVIEW_BRIEF='Fixed thirty-minute playback-only public pressure track. No examiner inference during playback. Source clauses, native jobs, painted revisions and resources require deferred independent audit.'
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
node scripts/native-signed-interview.mjs
$taskExit=$LASTEXITCODE
node scripts/summarize-deep-audio-duration.mjs $env:COPILOT_NATIVE_INTERVIEW_OUTPUT
if($LASTEXITCODE -ne 0){throw 'Pressure metric audit failed'}
node scripts/summarize-continuous-pressure.mjs $env:COPILOT_NATIVE_INTERVIEW_OUTPUT
if($LASTEXITCODE -ne 0){throw 'Pressure native-job metric audit failed'}
exit $taskExit
