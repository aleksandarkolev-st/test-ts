$ErrorActionPreference='Stop'
$taskRoot='artifacts/deep-interview-v71'
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
$taskLog=$taskRoot+'/recording-queue.jsonl'
if(Test-Path -LiteralPath $taskLog){throw 'Refusing duplicate recording queue; inspect its actual owner before resuming'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'meeting-copilot.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-backend-playback') }
if($taskLive){throw 'Another measured native session is active'}
function Record-Task($entry){
 $entry.recordedAt=[DateTimeOffset]::UtcNow.ToString('o');$entry.ownerPid=$PID
 $entry | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
Record-Task @{event='started';model='gpt-6.1-sol';effort='low';output='T24E390';microphone=$false;diagnostics='acceptance-only reader receipt, queue occupancy and callback waits';productionBehaviorChanged=$false}
try{
 foreach($taskDomain in @('general','systems','algorithms')){
  Record-Task @{event='starting';kind='elapsed_hour';domain=$taskDomain;minutes=60}
  & .\.local\run-deep-hour-v71.ps1 -Domain $taskDomain -Minutes 60 -Suffix hour-t
  if($LASTEXITCODE -ne 0){throw ('Measured interview failed: '+$taskDomain)}
  $taskSource=$taskRoot+'/'+$taskDomain+'-hour-t/interview.json'
  $taskTail=Get-Content -LiteralPath $taskSource -Tail 30
  if(!($taskTail -match '"stoppedCleanly": true')){throw ('Clean stop missing: '+$taskDomain)}
  Record-Task @{event='finished';kind='elapsed_hour';domain=$taskDomain;source=$taskSource}
 }
 Record-Task @{event='starting';kind='attached_hard_tests'}
 & .\.local\run-hard-probes-v71.ps1
 if($LASTEXITCODE -ne 0){throw 'Attached hard probes failed'}
 Record-Task @{event='finished';kind='attached_hard_tests'}
 Record-Task @{event='starting';kind='continuous_pressure';minutes=30}
 & .\.local\run-continuous-pressure-v71.ps1 -Suffix t
 if($LASTEXITCODE -ne 0){throw 'Continuous pressure capture failed'}
 Record-Task @{event='recordings_terminal';independentAccuracyPending=$true;architectureAuditPending=$true;goalComplete=$false}
}catch{
 Record-Task @{event='failed';error=$_.Exception.Message;goalComplete=$false}
 throw
}
