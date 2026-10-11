param(
 [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
 [string]$PilotSuffix = 'pilot',
 [string]$ExistingGpuScenario = ''
)
$ErrorActionPreference='Stop'
$taskBase=$EvidenceDirectory
foreach ($taskOption in @('COPILOT_NATIVE_INTERVIEW_MINUTES','COPILOT_NATIVE_INTERVIEW_CASE','COPILOT_NATIVE_INTERVIEW_REPLAY_DIR','COPILOT_NATIVE_INTERVIEW_QUESTION_FILE','COPILOT_NATIVE_INTERVIEW_WAVE_FILE','COPILOT_NATIVE_SKIP_REVIEW','COPILOT_NATIVE_RAPID','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_ACCEPTANCE_REMOTE_ONLY','COPILOT_INTENT_PROFILE','COPILOT_INTENT_BACKGROUND_IGNORE','COPILOT_DEEP_SELF_OUTPUT')) {
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
$env:COPILOT_DEEP_AUDIO='1'
$env:COPILOT_NATIVE_INTERVIEW_AUDIO='1'
$env:COPILOT_NATIVE_INTERVIEW_ROUNDS='12'
$env:COPILOT_NATIVE_OUTPUT='T24E390'
$env:COPILOT_NATIVE_SPEECH_CHUNK_MS='160'
$env:COPILOT_NATIVE_ANSWER_MODEL='gpt-6.1-sol'
$env:COPILOT_NATIVE_ANSWER_EFFORT='low'
$env:COPILOT_INTERVIEW_EXAMINER_MODEL='gpt-6.1-sol'
$env:COPILOT_INTERVIEW_EXAMINER_EFFORT='low'
$env:COPILOT_INTENT_MODE='existing'
$env:COPILOT_TRACE_PROVISIONAL='1'
$env:COPILOT_NEMO_DIAGNOSTICS='1'
foreach ($taskDomain in @('gpu','distributed','algorithms')) {
 $taskPilot=$taskBase+'/'+$taskDomain+'-'+$PilotSuffix
 $taskJournal=Get-Content -LiteralPath ($taskPilot+'/interview.json') -Raw | ConvertFrom-Json
 if ($taskJournal.status -ne 'complete' -or $taskJournal.rows.Count -lt 12) { throw ('Adaptive pilot incomplete: '+$taskDomain) }
 $env:COPILOT_NATIVE_INTERVIEW_SCENARIO=$taskPilot+'/scenario-request.scenario.json'
 if ($taskDomain -eq 'gpu' -and $ExistingGpuScenario) { $env:COPILOT_NATIVE_INTERVIEW_SCENARIO=$ExistingGpuScenario }
 $env:COPILOT_DEEP_REPLAY_FILE=$taskPilot+'/interview.json'
 $env:COPILOT_NATIVE_INTERVIEW_OUTPUT=$taskBase+'/'+$taskDomain+'-paired-replay'
 if (Test-Path -LiteralPath $env:COPILOT_NATIVE_INTERVIEW_OUTPUT) { throw 'Refusing to overwrite recorded replay' }
 Write-Output ('Starting paired '+$taskDomain+' replays; policy order alternates by source turn')
 & node scripts/native-signed-interview.mjs
 if ($LASTEXITCODE -ne 0) { throw ('Replay failed: '+$taskDomain+'; evidence preserved') }
}
