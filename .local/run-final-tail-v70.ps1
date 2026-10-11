param([Parameter(Mandatory=$true)][int]$QueueProcessId)
$ErrorActionPreference='Stop'
$taskRoot='artifacts/deep-interview-v70'
$taskLog=$taskRoot+'/final-tail-runs.jsonl'
if(Test-Path -LiteralPath $taskLog){throw 'A tail run already has evidence; inspect its live owner and recorded stages before resuming'}
$taskOwner=Get-Process -Id $QueueProcessId -ErrorAction SilentlyContinue
$taskOwnerStarted=if($taskOwner){$taskOwner.StartTime.ToUniversalTime().ToString('o')}else{$null}
function Write-TailRecord($taskRecord){
 $taskRecord.recordedAt=[DateTimeOffset]::UtcNow.ToString('o')
 $taskRecord | ConvertTo-Json -Depth 6 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
$taskStage='waiting_for_measured_queue'
Write-TailRecord @{event='waiting';queueProcessId=$QueueProcessId;queueProcessStartedAt=$taskOwnerStarted;model='gpt-6.1-sol';effort='low';output='T24E390';microphone=$false}
try{
 while($taskOwner){
  Start-Sleep -Seconds 15
  $taskOwner=Get-Process -Id $QueueProcessId -ErrorAction SilentlyContinue
  if($taskOwner -and $taskOwner.StartTime.ToUniversalTime().ToString('o') -ne $taskOwnerStarted){throw 'Queue PID was reused; inspect authoritative queue state'}
 }
 $taskQueue=Get-Content -LiteralPath ($taskRoot+'/remaining-runs.jsonl') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
 if($taskQueue.event -ne 'scheduled_playback_runs_finished'){throw 'Measured queue owner exited without the required terminal event; no recording is restarted'}
 $taskStage='midpoint_pause'
 Write-TailRecord @{event='starting';stage=$taskStage}
 & .\.local\run-midpoint-pause-v70.ps1
 Write-TailRecord @{event='finished';stage=$taskStage}
 # The recorder awaits meeting shutdown, then terminates its owned app.
 # Give that exact workspace app time to exit before normal saved auth starts.
 $taskExitDeadline=[DateTimeOffset]::UtcNow.AddSeconds(90)
 do{
  $taskOwnedApps=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'meeting-copilot.exe' -and $_.ExecutablePath -like '*\test-ts\.local\native-interview-app\*' }
  if($taskOwnedApps){Start-Sleep -Seconds 2}
 }while($taskOwnedApps -and [DateTimeOffset]::UtcNow -lt $taskExitDeadline)
 if($taskOwnedApps){throw 'The owned midpoint app is still live; preserve it for inspection'}
 $taskStage='chatgpt_backend_comparison'
 Write-TailRecord @{event='starting';stage=$taskStage}
 & .\.local\run-chatgpt-comparison-v70.ps1
 Write-TailRecord @{event='finished';stage=$taskStage}
 $taskStage='recorded_interview_independent_reviews'
 Write-TailRecord @{event='starting';stage=$taskStage}
 & .\.local\run-independent-assessments-v70.ps1
 Write-TailRecord @{event='finished';stage=$taskStage}
 if(Test-Path -LiteralPath ($taskRoot+'/chatgpt-backend-comparison/complete.json')){
  $taskStage='final_prompt_backend_independent_reviews'
  Write-TailRecord @{event='starting';stage=$taskStage}
  & .\.local\run-backend-assessments-v70.ps1
  Write-TailRecord @{event='finished';stage=$taskStage}
 }
 Write-TailRecord @{event='final_recordings_and_model_reviews_terminal';nativeBackendAssessmentAndConsolidationPending=$true;goalComplete=$false}
}catch{
 Write-TailRecord @{event='failed';stage=$taskStage;error=$_.Exception.Message;goalComplete=$false}
 throw
}
