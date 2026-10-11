param([string]$TaskRoot='artifacts/deep-interview-v71')
$ErrorActionPreference='Stop'
$taskLog=$TaskRoot+'/deferred-queue.jsonl'
function Record-Resume($entry){
 $entry.recordedAt=[DateTimeOffset]::UtcNow.ToString('o');$entry.ownerPid=$PID
 $entry | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
function Read-Json($file){Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json}
function Hash-File($file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
$taskQueue=@(Get-Content -LiteralPath ($TaskRoot+'/recording-queue.jsonl') -Encoding UTF8 | ForEach-Object {$_ | ConvertFrom-Json})
$taskDeferred=@(Get-Content -LiteralPath $taskLog -Encoding UTF8 | ForEach-Object {$_ | ConvertFrom-Json})
if($taskQueue[-1].event -ne 'failed' -or $taskDeferred[-1].event -ne 'failed'){throw 'This recovery requires retained terminal failures, not an active or completed queue'}
foreach($taskOwner in @($taskQueue[0].ownerPid,$taskDeferred[0].ownerPid)){
 if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskOwner)){throw 'Original owner PID is present; inspect identity before recovery'}
}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('meeting-copilot.exe','adaptive-interview.exe','assess-recorded-interview.exe') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-policy-playback|observe-pressure-events|record-binary-variant') }
if($taskLive){throw 'Measured capture, observer or reviewer still active'}
$taskPreparation=Read-Json ($TaskRoot+'/preparation.json')
foreach($taskSource in $taskPreparation.sources | Where-Object file -like 'src-tauri/*'){
 if((Hash-File $taskSource.file) -ne $taskSource.sha256){throw ('Baseline source or binary changed: '+$taskSource.file)}
}
$taskProof=@()
foreach($taskFinished in $taskQueue | Where-Object { $_.event -eq 'finished' -and $_.kind -eq 'elapsed_hour' }){
 $taskStart=$taskQueue | Where-Object { $_.event -eq 'starting' -and $_.kind -eq 'elapsed_hour' -and $_.domain -eq $taskFinished.domain } | Select-Object -Last 1
 $taskAuditFile=(Split-Path $taskFinished.source -Parent)+'/duration-audit.json'
 $taskAudit=Read-Json $taskAuditFile
 if($taskAudit.status -ne 'complete' -or !$taskAudit.stoppedCleanly -or !$taskAudit.durationVerified -or $taskAudit.actualInterviewDurationMs -lt $taskStart.minutes*60000){throw 'Incomplete hour duration evidence'}
 if((Hash-File $taskFinished.source) -ne $taskAudit.journalSha256){throw 'Hour journal differs from duration audit'}
 $taskProof+=@{file=$taskAuditFile;sha256=(Hash-File $taskAuditFile);journalSha256=$taskAudit.journalSha256}
}
if(!$taskProof.Count){throw 'No completed hour recordings'}
foreach($taskDirectory in Get-ChildItem -LiteralPath ($TaskRoot+'/hard-probes') -Directory){
 $taskAuditFile=$taskDirectory.FullName+'/duration-audit.json';$taskAudit=Read-Json $taskAuditFile
 if($taskAudit.status -ne 'complete' -or !$taskAudit.stoppedCleanly -or (Hash-File ($taskDirectory.FullName+'/interview.json')) -ne $taskAudit.journalSha256){throw ('Incomplete hard-probe evidence: '+$taskDirectory.Name)}
 $taskProof+=@{file=$taskAuditFile;sha256=(Hash-File $taskAuditFile);journalSha256=$taskAudit.journalSha256}
}
$taskPressure=$TaskRoot+'/continuous-pressure-t'
$taskDuration=Read-Json ($taskPressure+'/duration-audit.json')
$taskEvents=Read-Json ($taskPressure+'/pressure-events-audit.json')
$taskObserver=Read-Json ($taskPressure+'/native-events-observer-report.json')
if($taskDuration.status -ne 'complete' -or !$taskDuration.stoppedCleanly -or !$taskDuration.durationVerified -or $taskDuration.actualInterviewDurationMs -lt $taskDuration.requestedDurationMs){throw 'Pressure duration incomplete'}
if((Hash-File ($taskPressure+'/interview.json')) -ne $taskDuration.journalSha256 -or $taskEvents.journalSha256 -ne $taskDuration.journalSha256){throw 'Pressure journal binding changed'}
if((Hash-File ($taskPressure+'/native-events-observer.jsonl')) -ne $taskObserver.eventsFileSha256 -or $taskEvents.eventsSha256 -ne $taskObserver.eventsFileSha256){throw 'Observer evidence binding changed'}
if($taskObserver.stopReason -ne 'native_owner_exited' -or !$taskEvents.clocksValid -or $taskEvents.eventCounts.'meeting.stopped' -ne 1 -or (Get-Item ($TaskRoot+'/pressure-observer.err')).Length -ne 0){throw 'Observer terminal evidence incomplete'}
foreach($taskName in @('duration-audit.json','pressure-events-audit.json','native-events-observer-report.json')){$taskProof+=@{file=$taskPressure+'/'+$taskName;sha256=(Hash-File ($taskPressure+'/'+$taskName))}}
$taskTerminal=@{event='recordings_terminal';recordedAt=[DateTimeOffset]::UtcNow.ToString('o');ownerPid=$PID;recoveredFromWrapperFailure=$true;originalObserverExitCode=$null;proof=$taskProof;explanation='Original Start-Process wrapper rejected an unavailable exit code. Independent reproduction returned HasExited=true with ExitCode=null for process.exit(0). Saved pressure journal and read-only observer are complete and hash-bound; no recording was repeated.';goalComplete=$false}
$taskTerminal | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath ($TaskRoot+'/recording-queue.jsonl') -Encoding UTF8
$taskIdentity=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
Record-Resume @{event='resumed_after_validated_recording_failure';creationDate=$taskIdentity.CreationDate.ToUniversalTime().ToString('o');goalComplete=$false}
try{
 Record-Resume @{event='starting_policy_controls'}
 & .\.local\run-policy-controls-v71.ps1 -TaskRoot $TaskRoot
 if($LASTEXITCODE -ne 0){throw 'Policy controls failed; preserve evidence'}
 Record-Resume @{event='starting_independent_assessments'}
 & .\.local\run-assessments-v71.ps1 -TaskRoot $TaskRoot
 if($LASTEXITCODE -ne 0){throw 'Assessments failed; preserve cached judgments'}
 Record-Resume @{event='reviews_terminal';finalArchitectureAuditPending=$true;goalComplete=$false}
}catch{Record-Resume @{event='failed';error=$_.Exception.Message;goalComplete=$false};throw}
