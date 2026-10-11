$ErrorActionPreference='Stop'
$taskDirectory='artifacts/deep-interview-v70/backend-playback-comparison'
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview.mjs|record-backend-playback-v70.mjs' }
if($taskLive){throw 'Finish measured playback before reviewer inference'}
if(!(Test-Path -LiteralPath ($taskDirectory+'/codex-review-input.json'))){
 node .local/prepare-native-backend-review-v70.mjs
 if($LASTEXITCODE -ne 0){throw 'Native source projection failed'}
}
$env:COPILOT_INDEPENDENT_MODEL='gpt-6.1-sol'
$env:COPILOT_INDEPENDENT_EFFORT='low'
cargo build --manifest-path src-tauri/Cargo.toml --example assess-recorded-interview --features acceptance
if($LASTEXITCODE -ne 0){throw 'Reviewer build failed'}
foreach($taskBackend in @('codex','chatgpt')){
 & .\src-tauri\target\debug\examples\assess-recorded-interview.exe ($taskDirectory+'/'+$taskBackend+'-review-input.json') ($taskDirectory+'/'+$taskBackend+'-independent-model-review-v70')
 if($LASTEXITCODE -ne 0){throw ('Native review failed; cached rows remain preserved: '+$taskBackend)}
}
node scripts/summarize-native-backend-assessment.mjs $taskDirectory
if($LASTEXITCODE -ne 0){throw 'Native review and painted timing binding failed'}
