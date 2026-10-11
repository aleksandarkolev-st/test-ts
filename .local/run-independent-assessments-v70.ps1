$ErrorActionPreference='Stop'
$taskQueue=Get-Content -LiteralPath 'artifacts/deep-interview-v70/remaining-runs.jsonl' -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskQueue.event -ne 'scheduled_playback_runs_finished'){throw 'Finish the measured recording queue before independent inference or compilation'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'scripts/native-signed-interview.mjs|record-backend-playback-v70.mjs' }
if($taskLive){throw 'Refusing independent inference during measured playback'}
try{
 & .\.local\run-chatgpt-response-diagnostic-v70.ps1
}catch{
 Write-Warning ('Untimed response diagnostic needs inspection; continue independent recording reviews: '+$_.Exception.Message)
}
$taskRoot='artifacts/deep-interview-v70'
$taskRequiredPause=$taskRoot+'/hard-probes/long-question-essential-tail-midpoint-pause/interview.json'
if(!(Test-Path -LiteralPath $taskRequiredPause)){throw 'The required midpoint-pause recording is still missing'}
$taskSources=@('algorithms-hour-t','systems-hour-t','general-hour-t') | ForEach-Object { $taskRoot+'/'+$_+'/interview.json' }
$taskSources+=Get-ChildItem -LiteralPath ($taskRoot+'/hard-probes') -Directory | Sort-Object Name | ForEach-Object { $taskRoot+'/hard-probes/'+$_.Name+'/interview.json' }
$taskSources+=$taskRoot+'/continuous-pressure-t/pressure-review-input.json'
foreach($taskSource in $taskSources){
 $taskRecording=Get-Content -LiteralPath $taskSource -Raw -Encoding UTF8 | ConvertFrom-Json
 if($taskRecording.status -notin @('complete','failed') -or !$taskRecording.stoppedCleanly){throw ('Recording has not stopped cleanly: '+$taskSource)}
 if(!$taskRecording.rows -or $taskRecording.rows.Count -eq 0){throw ('No review rows: '+$taskSource)}
 if($taskRecording.model -ne 'gpt-6.1-sol' -or $taskRecording.effort -ne 'low'){throw ('Unexpected candidate model or effort: '+$taskSource)}
}
$env:COPILOT_INDEPENDENT_MODEL='gpt-6.1-sol'
$env:COPILOT_INDEPENDENT_EFFORT='low'
cargo build --manifest-path src-tauri/Cargo.toml --example assess-recorded-interview --features acceptance
if($LASTEXITCODE -ne 0){throw 'Independent reviewer build failed'}
foreach($taskSource in $taskSources){
 $taskParent=Split-Path -Path $taskSource -Parent
 $taskReviews=$taskParent+'/independent-model-review-v70'
 $taskSummary=$taskParent+'/independent-assessment-v70'
 & .\src-tauri\target\debug\examples\assess-recorded-interview.exe $taskSource $taskReviews
 if($LASTEXITCODE -ne 0){throw ('Independent review failed; completed cached rows remain preserved: '+$taskSource)}
 if(Test-Path -LiteralPath ($taskSummary+'/assessment.json')){
  $taskExisting=Get-Content -LiteralPath ($taskSummary+'/assessment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $taskHash=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $taskBound=if($taskExisting.journal){$taskExisting.journal.sha256}else{($taskExisting.evidence | Where-Object { $_.file -match 'pressure-review-input.json$' }).sha256}
  if($taskBound -ne $taskHash){throw ('Existing assessment belongs to different source: '+$taskSource)}
 }elseif($taskSource -match 'pressure-review-input.json$'){
  node scripts/summarize-pressure-assessment.mjs $taskParent $taskReviews $taskSummary
  if($LASTEXITCODE -ne 0){throw 'Pressure assessment source/timing binding failed'}
 }else{
  node scripts/summarize-deep-audio-interview.mjs $taskSource $taskReviews $taskSummary
  if($LASTEXITCODE -ne 0){throw ('Assessment source/timing binding failed: '+$taskSource)}
 }
}
Write-Output 'Recorded independent model reviews and source-bound timing summaries. Substantive checks and backend assessments remain separate.'
