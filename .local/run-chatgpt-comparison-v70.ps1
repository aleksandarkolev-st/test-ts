$ErrorActionPreference='Stop'
$taskRunning=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'scripts/native-signed-interview.mjs' }
if($taskRunning){throw 'Wait for measured playback recordings to finish before backend inference or compilation'}
$taskQueueLog=Get-Content -LiteralPath 'artifacts/deep-interview-v70/remaining-runs.jsonl' -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskQueueLog.event -ne 'scheduled_playback_runs_finished'){throw 'Required recordings have not all finished; preserve the current serial queue'}
$taskOtherApps=Get-Process -Name meeting-copilot -ErrorAction SilentlyContinue
if($taskOtherApps){throw 'Close or stop other app instances before sharing saved ChatGPT refresh credentials'}
foreach($taskOption in @('COPILOT_ACCEPTANCE','COPILOT_TEST_API','COPILOT_ACCEPTANCE_INPUT_ONLY')){
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
$taskOutput='artifacts/deep-interview-v70/chatgpt-backend-comparison'
if(Test-Path -LiteralPath $taskOutput){throw 'Refusing to overwrite backend comparison evidence'}
cargo build --manifest-path src-tauri/Cargo.toml --example compare-answer-backends --features acceptance
if($LASTEXITCODE -ne 0){throw 'Comparison helper failed to build; no backend inference started'}
& .\src-tauri\target\debug\examples\compare-answer-backends.exe 'artifacts/deep-interview-v70/backend-comparison-cases.json' $taskOutput
if($LASTEXITCODE -ne 0){throw 'Backend comparison failed; preserve its completed preflight and trial records'}
Get-Content -LiteralPath ($taskOutput+'/chatgpt-preflight.json') -Encoding UTF8
$taskPreflight=Get-Content -LiteralPath ($taskOutput+'/chatgpt-preflight.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($taskPreflight.status -eq 'available'){
 node .local/record-backend-playback-v70.mjs
 if($LASTEXITCODE -ne 0){throw 'Actual backend playback failed; preserve its recording and observed error'}
}
