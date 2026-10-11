param([string]$Cases='', [ValidatePattern('^[a-z0-9-]*$')][string]$Suffix='', [switch]$ExactDigitalPause)
$ErrorActionPreference='Stop'
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'scripts/native-signed-interview.mjs' }
if($taskLive){throw 'Refusing to overlap measured audio interviews'}
$taskSuite=Get-Content -LiteralPath tests/fixtures/hard-interview-audio-suite.json -Raw -Encoding UTF8 | ConvertFrom-Json
$taskBase='artifacts/deep-interview-v71/hard-probes'
New-Item -ItemType Directory -Path $taskBase -Force | Out-Null
foreach($taskOption in @('COPILOT_NATIVE_INTERVIEW_MINUTES','COPILOT_NATIVE_INTERVIEW_CASE','COPILOT_NATIVE_INTERVIEW_QUESTION_FILE','COPILOT_NATIVE_INTERVIEW_WAVE_FILE','COPILOT_NATIVE_INTERVIEW_REPLAY_DIR','COPILOT_NATIVE_INTERVIEW_REPLAY_PREFIX_ROUNDS','COPILOT_NATIVE_SKIP_REVIEW','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_NATIVE_RAPID','COPILOT_DEEP_REPLAY_FILE','COPILOT_INTENT_PROFILE','COPILOT_ACCEPTANCE_SELF_LOOPBACK','COPILOT_DEEP_SELF_OUTPUT')) {
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
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
$taskSelected=if($Cases){$Cases.Split(',')}else{@()}
foreach($taskCase in $taskSuite.cases){
 if($taskSelected.Count -gt 0 -and $taskCase.name -notin $taskSelected){continue}
 if($taskCase.name -notmatch '^[a-z0-9-]+$'){throw 'Invalid case path'}
 $taskLabel=$taskCase.name+$(if($Suffix){'-'+$Suffix}else{''})
 $env:COPILOT_NATIVE_INTERVIEW_OUTPUT=$taskBase+'/'+$taskLabel
 if(Test-Path -LiteralPath $env:COPILOT_NATIVE_INTERVIEW_OUTPUT){throw 'Refusing to overwrite exact-probe evidence'}
 $taskScenario=$taskCase.scenario
 $env:COPILOT_DEEP_OLDER_CODE_PROBE=if($taskCase.delivery.enableOlderCodeProbe -eq $true){'1'}else{'0'}
 $taskDelivery=if($taskCase.delivery){$taskCase.delivery}else{[pscustomobject]@{immediateAfterRounds=[pscustomobject]@{}}}
 if($ExactDigitalPause){$taskDelivery | Add-Member -NotePropertyName exactDigitalPause -NotePropertyValue $true -Force}
 if(!$taskDelivery.PSObject.Properties['immediateAfterRounds']){
  $taskDelivery | Add-Member -NotePropertyName immediateAfterRounds -NotePropertyValue ([pscustomobject]@{})
 }
 $taskScenario | Add-Member -NotePropertyName evaluationDelivery -NotePropertyValue $taskDelivery
 $taskFile=$taskBase+'/'+$taskLabel+'.scenario.json'
 if(Test-Path -LiteralPath $taskFile){throw 'Refusing to overwrite provided scenario'}
 [IO.File]::WriteAllText((Join-Path (Get-Location).Path $taskFile),(@{scenario=$taskScenario;sourceFixture='tests/fixtures/hard-interview-audio-suite.json';requirementIds=$taskCase.requirementIds}|ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
 $env:COPILOT_NATIVE_INTERVIEW_SCENARIO=$taskFile
 $env:COPILOT_NATIVE_INTERVIEW_ROUNDS=[string]$taskCase.rounds
 $env:COPILOT_NATIVE_INTERVIEW_BRIEF='Evaluate this provided attached hard-test requirement against its actual public question only. Each generated follow-up depends on the actual answer. '+$taskCase.brief
 Write-Output ('Starting exact playback-only probe: '+$taskCase.name)
 node scripts/native-signed-interview.mjs
 $taskExit=$LASTEXITCODE
 node scripts/summarize-deep-audio-duration.mjs $env:COPILOT_NATIVE_INTERVIEW_OUTPUT
 if($LASTEXITCODE -ne 0){throw 'Probe metric audit failed'}
 if($taskExit -ne 0){throw ('Probe failed; original evidence retained: '+$taskCase.name)}
}
