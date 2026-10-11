$ErrorActionPreference='Stop'
$taskMeasured=Get-CimInstance Win32_Process | Where-Object {
 $_.Name -eq 'compare-answer-backends.exe' -or
 ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview.mjs|record-backend-playback-v70.mjs')
}
if($taskMeasured){throw 'Finish measured backend requests and native playback before this untimed diagnostic'}
if(Get-Process -Name meeting-copilot -ErrorAction SilentlyContinue){throw 'Wait for app exit before sharing normal saved refresh credentials'}
$taskOutput='artifacts/deep-interview-v70/chatgpt-response-diagnostic'
if(Test-Path -LiteralPath $taskOutput){
 if(Test-Path -LiteralPath ($taskOutput+'/response-diagnostic.json')){Write-Output 'Preserving completed response diagnostic';return}
 throw 'Inspect incomplete diagnostic evidence before any retry'
}
foreach($taskOption in @('COPILOT_ACCEPTANCE','COPILOT_TEST_API','COPILOT_ACCEPTANCE_INPUT_ONLY')){
 Remove-Item -LiteralPath ('Env:'+$taskOption) -ErrorAction SilentlyContinue
}
cargo build --manifest-path src-tauri/Cargo.toml --example diagnose-chatgpt-response --features acceptance
if($LASTEXITCODE -ne 0){throw 'Response diagnostic build failed'}
& .\src-tauri\target\debug\examples\diagnose-chatgpt-response.exe 'artifacts/deep-interview-v70/backend-comparison-cases.json' $taskOutput
if($LASTEXITCODE -ne 0){throw 'Response diagnostic failed; preserve its evidence'}
