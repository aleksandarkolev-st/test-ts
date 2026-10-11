param([string]$TaskRoot='artifacts/deep-interview-v71')
$ErrorActionPreference='Stop'
$taskLog=$TaskRoot+'/deferred-queue.jsonl'
function Record-AssessmentResume($entry){
 $entry.recordedAt=[DateTimeOffset]::UtcNow.ToString('o');$entry.ownerPid=$PID
 $entry | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
$taskLast=Get-Content -LiteralPath $taskLog -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskLast.event -ne 'failed'){throw 'Require a retained terminal failure before assessment recovery'}
if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskLast.ownerPid)){throw 'Previous assessment owner PID exists; inspect identity before resuming'}
$taskState=Get-Content -LiteralPath ($TaskRoot+'/recording-queue.jsonl') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskState.event -ne 'recordings_terminal'){throw 'Measured baseline recordings are not terminal'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('meeting-copilot.exe','adaptive-interview.exe','assess-recorded-interview.exe','cargo.exe','rustc.exe') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-policy-playback|record-binary-variant') }
if($taskLive){throw 'A capture, compiler or reviewer remains active'}
$taskControl=Get-Content -LiteralPath ($TaskRoot+'/policy-playback/playback.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskManifest=Get-Content -LiteralPath ($TaskRoot+'/policy-playback/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($taskControl.status -ne 'complete' -or !$taskControl.stoppedCleanly -or $taskControl.trials.Count -ne $taskManifest.cases.Count*$taskManifest.repetitions*$taskManifest.policies.Count){throw 'Policy controls are incomplete'}
if($taskControl.manifestSha256 -ne (Get-FileHash -LiteralPath ($TaskRoot+'/policy-playback/manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Policy manifest changed'}
$taskIdentity=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
Record-AssessmentResume @{event='resumed_independent_assessments';creationDate=$taskIdentity.CreationDate.ToUniversalTime().ToString('o');previousFailure=$taskLast.error;policyPlaybackSha256=(Get-FileHash -LiteralPath ($TaskRoot+'/policy-playback/playback.json') -Algorithm SHA256).Hash.ToLowerInvariant();repeatsCompletedRecordings=$false;goalComplete=$false}
try{
 & .\.local\run-assessments-v71.ps1 -TaskRoot $TaskRoot
 if($LASTEXITCODE -ne 0){throw 'Deferred assessment failed; preserve all attempts'}
 Record-AssessmentResume @{event='reviews_terminal';finalArchitectureAuditPending=$true;goalComplete=$false}
}catch{Record-AssessmentResume @{event='failed';error=$_.Exception.Message;goalComplete=$false};throw}
