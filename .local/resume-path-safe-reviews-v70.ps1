param([switch]$ContinueRecordedFailure)
$ErrorActionPreference='Stop'
$taskLog='artifacts/deep-interview-v70/final-tail-path-resume-v70.jsonl'
if(Get-Process -Name assess-recorded-interview,compare-answer-backends,meeting-copilot -ErrorAction SilentlyContinue){throw 'An inference or capture owner remains live'}
if(Test-Path -LiteralPath $taskLog){
 $taskPrevious=Get-Content -LiteralPath $taskLog -Tail 1 -Encoding UTF8 | ConvertFrom-Json
 if(!$ContinueRecordedFailure -or $taskPrevious.event -ne 'failed'){throw 'Inspect existing resume owner and evidence before retry'}
}
function Write-PathResume($taskRecord){
 $taskRecord.recordedAt=[DateTimeOffset]::UtcNow.ToString('o')
 $taskRecord.ownerPid=$PID
 $taskRecord | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
$taskStage='remaining_recorded_independent_reviews'
try{
 Write-PathResume @{event='starting';stage=$taskStage;reason='Previous runner passed absolute hard-probe output paths to a workspace-relative reviewer; use relative paths and preserve all cached judgments';model='gpt-6.1-sol';effort='low'}
 & .\.local\run-independent-assessments-v70.ps1
 Write-PathResume @{event='finished';stage=$taskStage}
 $taskStage='all_backend_independent_reviews'
 Write-PathResume @{event='starting';stage=$taskStage}
 & .\.local\run-backend-assessments-v70.ps1
 Write-PathResume @{event='finished';stage=$taskStage}
 Write-PathResume @{event='recordings_and_reviews_terminal';goalComplete=$false;consolidationPending=$true}
}catch{
 Write-PathResume @{event='failed';stage=$taskStage;error=$_.Exception.Message;goalComplete=$false}
 throw
}
