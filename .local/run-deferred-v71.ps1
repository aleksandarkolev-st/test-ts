$ErrorActionPreference='Stop'
$taskRoot='artifacts/deep-interview-v71'
$taskLog=$taskRoot+'/deferred-queue.jsonl'
if(Test-Path -LiteralPath $taskLog){throw 'Deferred owner already recorded; inspect actual process identity before any continuation'}
$taskOwner=24692
$taskCreation=1791700501977L
function Record-Deferred($entry){
 $entry.recordedAt=[DateTimeOffset]::UtcNow.ToString('o');$entry.ownerPid=$PID
 $entry | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
$taskParent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskOwner)
if(!$taskParent -or [DateTimeOffset]::new($taskParent.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() -ne $taskCreation){throw 'Recording owner identity changed; do not start a deferred queue automatically'}
Record-Deferred @{event='waiting_for_recordings';recordingOwner=$taskOwner;recordingCreationEpochMs=$taskCreation;goalComplete=$false}
try{
 while($true){
  $taskState=Get-Content -LiteralPath ($taskRoot+'/recording-queue.jsonl') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
  if($taskState.event -eq 'recordings_terminal'){break}
  if($taskState.event -eq 'failed'){throw ('Measured queue failed: '+$taskState.error)}
  $taskParent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskOwner)
  if(!$taskParent -or [DateTimeOffset]::new($taskParent.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() -ne $taskCreation){throw 'Recording owner exited without terminal evidence'}
  Start-Sleep -Seconds 15
 }
 Record-Deferred @{event='starting_policy_controls';trials=24}
 & .\.local\run-policy-controls-v71.ps1
 if($LASTEXITCODE -ne 0){throw 'Policy controls failed; retain partial evidence'}
 Record-Deferred @{event='starting_independent_assessments'}
 & .\.local\run-assessments-v71.ps1
 if($LASTEXITCODE -ne 0){throw 'Deferred assessments failed; retain cached judgments'}
 Record-Deferred @{event='reviews_terminal';finalArchitectureAuditPending=$true;substantiveCodeChecksPending=$true;goalComplete=$false}
}catch{
 Record-Deferred @{event='failed';error=$_.Exception.Message;goalComplete=$false}
 throw
}
