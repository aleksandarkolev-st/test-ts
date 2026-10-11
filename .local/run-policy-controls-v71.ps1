param([string]$TaskRoot='artifacts/deep-interview-v71')
$ErrorActionPreference='Stop'
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'meeting-copilot.exe' -or $_.Name -eq 'adaptive-interview.exe' -or $_.Name -eq 'assess-recorded-interview.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-policy-playback') }
if($taskLive){throw 'Finish all measured sessions and inference before policy controls'}
node --expose-gc --max-old-space-size=6144 .local/prepare-policy-controls-v71.mjs $taskRoot
if($LASTEXITCODE -ne 0){throw 'Policy control source preparation failed'}
node --expose-gc --max-old-space-size=6144 .local/record-policy-playback-v71.mjs $taskRoot
if($LASTEXITCODE -ne 0){throw 'Policy control recording failed; preserve evidence'}
