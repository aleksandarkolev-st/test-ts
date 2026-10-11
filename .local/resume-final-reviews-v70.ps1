$ErrorActionPreference='Stop'
$taskLog='artifacts/deep-interview-v70/final-tail-resume-v70.jsonl'
if(Get-Process -Id 45956 -ErrorAction SilentlyContinue){throw 'Original tail owner is still live'}
if(Get-Process -Name assess-recorded-interview,compare-answer-backends,meeting-copilot -ErrorAction SilentlyContinue){throw 'An inference or capture owner remains live'}
if(Test-Path -LiteralPath $taskLog){throw 'Inspect existing resume owner and evidence before retry'}
function Write-Resume($taskRecord){
 $taskRecord.recordedAt=[DateTimeOffset]::UtcNow.ToString('o')
 $taskRecord.ownerPid=$PID
 $taskRecord | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath $taskLog -Encoding UTF8
}
$taskStage='no_tier_paired_requests'
try{
 Write-Resume @{event='starting';stage=$taskStage;reason='Original grader exited with Codex answer timed out after systems review 15; no recording restarted';model='gpt-6.1-sol';effort='low'}
 & .\.local\run-backend-no-tier-v70.ps1 -RecordOnly
 Write-Resume @{event='finished';stage=$taskStage}
 $taskStage='remaining_recorded_independent_reviews'
 Write-Resume @{event='starting';stage=$taskStage}
 & .\.local\run-independent-assessments-v70.ps1
 Write-Resume @{event='finished';stage=$taskStage}
 $taskStage='all_backend_independent_reviews'
 Write-Resume @{event='starting';stage=$taskStage}
 & .\.local\run-backend-assessments-v70.ps1
 Write-Resume @{event='finished';stage=$taskStage}
 Write-Resume @{event='recordings_and_reviews_terminal';goalComplete=$false;consolidationPending=$true}
}catch{
 Write-Resume @{event='failed';stage=$taskStage;error=$_.Exception.Message;goalComplete=$false}
 throw
}
