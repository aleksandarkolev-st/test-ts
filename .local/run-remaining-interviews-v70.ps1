param([switch]$ResumeWaiting)
$ErrorActionPreference='Stop'
$taskCurrent='artifacts/deep-interview-v70/algorithms-hour-t/interview.json'
$taskLog='artifacts/deep-interview-v70/remaining-runs.jsonl'
if(Test-Path -LiteralPath $taskLog){
 if(!$ResumeWaiting){throw 'Refusing to overwrite queued-run evidence'}
 $taskLast=Get-Content -LiteralPath $taskLog -Tail 1 | ConvertFrom-Json
 if($taskLast.event -notin @('waiting','waiting_resumed')){throw 'Only a waiting queue can be resumed without inspecting started runs'}
}
function Write-TaskRecord($taskRecord){
 $taskRecord.recordedAt=[DateTimeOffset]::UtcNow.ToString('o')
 $taskRecord | ConvertTo-Json -Depth 6 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
Write-TaskRecord @{event=$(if($ResumeWaiting){'waiting_resumed'}else{'waiting'});source=$taskCurrent;model='gpt-6.1-sol';effort='low';output='T24E390';microphone=$false}
while(!((Get-Content -LiteralPath $taskCurrent -TotalCount 3) -match '"status": "(complete|failed)"')){
 Start-Sleep -Seconds 15
}
# The journal can become terminal before the owner finishes clean shutdown.
while(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'scripts/native-signed-interview.mjs' }){
 Start-Sleep -Seconds 5
}
$taskShutdownDeadline=[DateTimeOffset]::UtcNow.AddSeconds(90)
do{
 $taskStream=[IO.File]::Open($taskCurrent,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
 try{
  $taskBytes=[byte[]]::new([Math]::Min(65536,$taskStream.Length))
  [void]$taskStream.Seek(-$taskBytes.Length,[IO.SeekOrigin]::End)
  [void]$taskStream.Read($taskBytes,0,$taskBytes.Length)
  $taskTail=[Text.Encoding]::UTF8.GetString($taskBytes)
 }finally{$taskStream.Dispose()}
 $taskClean=$taskTail -match '"stoppedCleanly": true'
 if(!$taskClean){Start-Sleep -Seconds 5}
}while(!$taskClean -and [DateTimeOffset]::UtcNow -lt $taskShutdownDeadline)
Write-TaskRecord @{event='prior_run_terminal';stoppedCleanly=$taskClean}
if(!$taskClean){throw 'Prior run lacks clean shutdown; inspect before opening another measured session'}
$taskSuite=Get-Content -LiteralPath tests/fixtures/hard-interview-audio-suite.json -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($taskCase in $taskSuite.cases){
 Write-TaskRecord @{event='starting';kind='exact_probe';name=$taskCase.name}
 try{
  & .\.local\run-hard-probes-v70.ps1 -Cases $taskCase.name
  Write-TaskRecord @{event='finished';kind='exact_probe';name=$taskCase.name;exitCode=$LASTEXITCODE}
 }catch{
  Write-TaskRecord @{event='failed';kind='exact_probe';name=$taskCase.name;error=$_.Exception.Message}
  throw
 }
}
Write-TaskRecord @{event='starting';kind='continuous_pressure';minutes=30}
& .\.local\run-continuous-pressure-v70.ps1
if($LASTEXITCODE -ne 0){throw 'Continuous pressure failed; evidence retained'}
Write-TaskRecord @{event='finished';kind='continuous_pressure';exitCode=$LASTEXITCODE}
foreach($taskDomain in @('systems','general')){
 Write-TaskRecord @{event='starting';kind='elapsed_hour';domain=$taskDomain;minutes=60}
 & .\.local\run-deep-hour-v70.ps1 -Domain $taskDomain -Minutes 60 -Suffix hour-t
 if($LASTEXITCODE -ne 0){throw ('Elapsed interview failed: '+$taskDomain)}
 Write-TaskRecord @{event='finished';kind='elapsed_hour';domain=$taskDomain;exitCode=$LASTEXITCODE}
}
Write-TaskRecord @{event='scheduled_playback_runs_finished';independentAssessmentPending=$true;goalComplete=$false}
