$ErrorActionPreference='Stop'
$taskDirectory='artifacts/deep-interview-v70/chatgpt-backend-comparison'
$taskQueue=Get-Content -LiteralPath 'artifacts/deep-interview-v70/remaining-runs.jsonl' -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskQueue.event -ne 'scheduled_playback_runs_finished'){throw 'Finish measured playback before reviewer inference'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview.mjs|record-backend-playback-v70.mjs' }
if($taskLive){throw 'Measured playback still has a live owner'}
if(!(Test-Path -LiteralPath ($taskDirectory+'/complete.json'))){throw 'Paired comparison trials are incomplete; inspect preflight and preserved evidence'}
if(!(Test-Path -LiteralPath ($taskDirectory+'/codex-review-input.json'))){
 node .local/prepare-backend-review-v70.mjs
 if($LASTEXITCODE -ne 0){throw 'Comparison source projection failed'}
}
$env:COPILOT_INDEPENDENT_MODEL='gpt-6.1-sol'
$env:COPILOT_INDEPENDENT_EFFORT='low'
cargo build --manifest-path src-tauri/Cargo.toml --example assess-recorded-interview --features acceptance
if($LASTEXITCODE -ne 0){throw 'Reviewer build failed'}
foreach($taskBackend in @('codex','chatgpt')){
 & .\src-tauri\target\debug\examples\assess-recorded-interview.exe ($taskDirectory+'/'+$taskBackend+'-review-input.json') ($taskDirectory+'/'+$taskBackend+'-independent-model-review-v70')
 if($LASTEXITCODE -ne 0){throw ('Backend review failed; cached rows remain preserved: '+$taskBackend)}
}
node scripts/summarize-answer-backend-comparison.mjs $taskDirectory
if($LASTEXITCODE -ne 0){throw 'Backend review and request timing binding failed'}
if(Test-Path -LiteralPath 'artifacts/deep-interview-v70/backend-playback-comparison/playback.json'){
 & .\.local\run-native-backend-assessments-v70.ps1
}
& .\.local\run-backend-no-tier-v70.ps1
