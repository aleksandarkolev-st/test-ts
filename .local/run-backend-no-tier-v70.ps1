param([switch]$RecordOnly)
$ErrorActionPreference='Stop'
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('meeting-copilot.exe','assess-recorded-interview.exe','compare-answer-backends.exe') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview.mjs|record-backend-playback-v70.mjs') }
if($taskLive){throw 'Finish other inference and candidate playback before measuring the separate no-tier comparison'}
$taskManifest='artifacts/deep-interview-v70/backend-comparison-no-tier-cases.json'
$taskDirectory='artifacts/deep-interview-v70/chatgpt-backend-comparison-no-tier'
if(!(Test-Path -LiteralPath ($taskDirectory+'/complete.json'))){
 if(Test-Path -LiteralPath $taskDirectory){throw 'Inspect incomplete no-tier comparison before retry; preserve its evidence'}
 & .\src-tauri\target\debug\examples\compare-answer-backends.exe $taskManifest $taskDirectory
 if($LASTEXITCODE -ne 0){throw 'Separate no-tier comparison failed; preserve recorded trials'}
}
if(!(Test-Path -LiteralPath ($taskDirectory+'/codex-review-input.json'))){
 node .local/prepare-backend-review-v70.mjs $taskManifest $taskDirectory
 if($LASTEXITCODE -ne 0){throw 'No-tier comparison source projection failed'}
}
if($RecordOnly){Write-Output 'Separate no-tier paired requests and source projections complete; independent reviews deferred';return}
$env:COPILOT_INDEPENDENT_MODEL='gpt-6.1-sol'
$env:COPILOT_INDEPENDENT_EFFORT='low'
foreach($taskBackend in @('codex','chatgpt')){
 & .\src-tauri\target\debug\examples\assess-recorded-interview.exe ($taskDirectory+'/'+$taskBackend+'-review-input.json') ($taskDirectory+'/'+$taskBackend+'-independent-model-review-v70')
 if($LASTEXITCODE -ne 0){throw ('Separate no-tier independent review failed: '+$taskBackend)}
}
if(!(Test-Path -LiteralPath ($taskDirectory+'/independent-comparison-v70.json'))){
 node scripts/summarize-answer-backend-comparison.mjs $taskDirectory
 if($LASTEXITCODE -ne 0){throw 'No-tier comparison summary binding failed'}
}
