param([string]$TaskRoot='artifacts/deep-interview-v71')
$ErrorActionPreference='Stop'
$taskQueue=Get-Content -LiteralPath ($taskRoot+'/recording-queue.jsonl') -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json }
$taskState=Get-Content -LiteralPath ($taskRoot+'/recording-queue.jsonl') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskState.event -ne 'recordings_terminal'){throw 'Finish all fresh measured recordings before deferred assessments'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'meeting-copilot.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-backend-playback') }
if($taskLive){throw 'A measured native session is still active'}
$taskControl=Get-Content -LiteralPath ($taskRoot+'/policy-playback/playback.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskManifest=Get-Content -LiteralPath ($taskRoot+'/policy-playback/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskExpectedTrials=$taskManifest.cases.Count*$taskManifest.repetitions*$taskManifest.policies.Count
if($taskControl.status -ne 'complete' -or !$taskControl.stoppedCleanly -or $taskControl.trials.Count -ne $taskExpectedTrials){throw 'Finish all matched fresh-meeting policy controls before deferred assessment'}
if(Test-Path -LiteralPath '.local/latest-question-wins/src-tauri/Cargo.toml'){
 & .\.local\run-architecture-comparison-v71.ps1 -TaskRoot $TaskRoot
}
& .\.local\prepare-cuda-compiler-v71.ps1 -TaskRoot $TaskRoot
$taskCudaToolchain=$TaskRoot+'/cuda-compiler/toolchain.json'
$taskPressure=$taskRoot+'/continuous-pressure-t'
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-events-audit.json'))){
 node scripts/audit-pressure-event-recording.mjs $taskPressure
 if($LASTEXITCODE -ne 0){throw 'Pressure event binding failed'}
}
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-lexical-alignment.json'))){
 node .local/audit-pressure-clauses-v71.mjs
 if($LASTEXITCODE -ne 0){throw 'Pressure source alignment failed'}
}
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-token-alignment.json'))){
 node .local/audit-pressure-clauses-v71.mjs --tokens-only
 if($LASTEXITCODE -ne 0){throw 'Pressure token binding failed'}
}
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-review-input.json'))){
 node .local/prepare-pressure-review-v71.mjs
 if($LASTEXITCODE -ne 0){throw 'Pressure review projection failed'}
}
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-source-coverage-audit.json'))){
 node scripts/audit-pressure-source-coverage.mjs $taskPressure
 if($LASTEXITCODE -ne 0){throw 'Pressure source coverage binding failed'}
}
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-physical-latency-audit.json'))){
 node --max-old-space-size=6144 scripts/audit-pressure-physical-latency.mjs $taskPressure
 if($LASTEXITCODE -ne 0){throw 'Pressure physical source endpoint audit failed'}
}
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-drift-audit.json'))){
 node .local/audit-pressure-drift-v71.mjs
 if($LASTEXITCODE -ne 0){throw 'Pressure resource and latency drift audit failed'}
}
if(!(Test-Path -LiteralPath ($taskPressure+'/pressure-visibility-audit.json'))){
 node .local/audit-pressure-visibility-v71.mjs
 if($LASTEXITCODE -ne 0){throw 'Pressure display attribution audit failed'}
}
$taskSources=@($taskQueue | Where-Object { $_.event -eq 'finished' -and $_.kind -eq 'elapsed_hour' } | ForEach-Object { $_.source })
if(!$taskSources.Count -or @($taskSources | Sort-Object -Unique).Count -ne $taskSources.Count){throw 'Missing or duplicate completed recordings in queue'}
$taskHourSources=@($taskSources)
$taskCodeSelectionFile='docs/evidence/recorded-code-selections-v71.json'
$taskCodeSelections=Get-Content -LiteralPath $taskCodeSelectionFile -Raw -Encoding UTF8 | ConvertFrom-Json
$taskSources+=Get-ChildItem -LiteralPath ($taskRoot+'/hard-probes') -Directory | Sort-Object Name | ForEach-Object { $taskRoot+'/hard-probes/'+$_.Name+'/interview.json' }
$taskSources+=$taskPressure+'/pressure-review-input.json'
$taskSources+=$taskControl.trials | ForEach-Object { $_.outputDirectory+'/interview.json' }
$taskComparison=$TaskRoot+'/architecture-comparison/comparison.json'
if(Test-Path -LiteralPath $taskComparison){
 $taskArchitecture=Get-Content -LiteralPath $taskComparison -Raw -Encoding UTF8 | ConvertFrom-Json
 if($taskArchitecture.status -ne 'complete' -or !$taskArchitecture.stoppedCleanly){throw 'Architecture comparison did not finish cleanly'}
 $taskSources+=$taskArchitecture.trials | ForEach-Object { $_.recording }
}
$taskConfiguration=$taskQueue | Where-Object event -eq 'started' | Select-Object -First 1
$env:COPILOT_INDEPENDENT_MODEL=$taskConfiguration.model
$env:COPILOT_INDEPENDENT_EFFORT=$taskConfiguration.effort
if(!(Test-Path -LiteralPath ($taskRoot+'/decoder-benchmark/results.json'))){
 node --expose-gc --max-old-space-size=6144 .local/benchmark-decoder-v71.mjs $taskRoot
 if($LASTEXITCODE -ne 0){throw 'Offline decoder benchmark failed; preserve source and raw output'}
}
cargo build --manifest-path src-tauri/Cargo.toml --example assess-recorded-interview --features acceptance
if($LASTEXITCODE -ne 0){throw 'Independent reviewer build failed'}
foreach($taskSource in $taskSources){
 $taskParent=Split-Path -Path $taskSource -Parent
 $taskReviews=$taskParent+'/independent-model-review-v71'
 $taskSummary=$taskParent+'/independent-assessment-v71'
 foreach($taskCodeCheck in $taskCodeSelections.checks | Where-Object file -eq $taskSource){
  if($taskCodeCheck.kind -ne 'directed_graph_walk_classifier'){throw 'Unregistered explicit code-check contract'}
  node --max-old-space-size=6144 $taskCodeCheck.collector $taskSource $taskCodeCheck.round $taskCodeCheck.outputDirectory $taskCodeSelectionFile
  if($LASTEXITCODE -ne 0){throw ('Code-check evidence binding failed: '+$taskSource)}
 }
 if($taskSource -notmatch 'pressure-review-input.json$'){
  node --max-old-space-size=6144 .local/compile-recorded-cuda-v71.mjs $taskSource $taskCudaToolchain ($taskParent+'/code-review/nvcc-compilation-v71')
  if($LASTEXITCODE -ne 0){throw ('Recorded compiler evidence binding failed: '+$taskSource)}
  if(!(Test-Path -LiteralPath ($taskParent+'/older-code-reference-audit.json'))){
   node --max-old-space-size=6144 scripts/audit-older-code-reference.mjs $taskParent
   if($LASTEXITCODE -ne 0){throw ('Recorded older-code reference audit failed: '+$taskSource)}
  }
 }
 if($taskSource -notmatch 'pressure-review-input.json$'){
  if(!(Test-Path -LiteralPath ($taskParent+'/architecture-audit-v71.json'))){
   if($taskSource -match 'architecture-comparison[\\/]'){
    node --max-old-space-size=6144 .local/analyze-architecture-v71.mjs $taskParent --numeric-only
   }else{
    node --max-old-space-size=6144 .local/analyze-architecture-v71.mjs $taskParent
   }
   if($LASTEXITCODE -ne 0){throw ('Architecture source/timing audit failed: '+$taskSource)}
  }
  if(!(Test-Path -LiteralPath ($taskParent+'/delivery-coverage-audit.json'))){
   node --max-old-space-size=6144 scripts/audit-interview-delivery-coverage.mjs $taskParent
   if($LASTEXITCODE -ne 0){throw ('Waveform and delivery coverage audit failed: '+$taskSource)}
  }
  if(!(Test-Path -LiteralPath ($taskParent+'/interview-visibility-audit-v71.json'))){
   node --max-old-space-size=6144 .local/audit-interview-visibility-v71.mjs $taskParent
   if($LASTEXITCODE -ne 0){throw ('Question display attribution failed: '+$taskSource)}
  }
 }
 & .\src-tauri\target\debug\examples\assess-recorded-interview.exe $taskSource $taskReviews
 if($LASTEXITCODE -ne 0){throw ('Independent review failed; preserve cached judgments: '+$taskSource)}
 if(Test-Path -LiteralPath ($taskSummary+'/assessment.json')){
  $taskExisting=Get-Content -LiteralPath ($taskSummary+'/assessment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $taskBound=if($taskExisting.journal){$taskExisting.journal.sha256}else{($taskExisting.evidence | Where-Object file -match 'pressure-review-input.json$').sha256}
  if($taskBound -ne (Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Existing assessment source changed'}
 }elseif($taskSource -match 'pressure-review-input.json$'){
  node scripts/summarize-pressure-assessment.mjs $taskParent $taskReviews $taskSummary
  if($LASTEXITCODE -ne 0){throw 'Pressure assessment binding failed'}
 }else{
  node --max-old-space-size=6144 .local/summarize-recorded-review-v71.mjs $taskSource $taskReviews $taskSummary
  if($LASTEXITCODE -ne 0){throw ('Source and useful-phrase timing binding failed: '+$taskSource)}
 }
}
Write-Output 'All fresh recorded reviews and useful-phrase timings terminal. Architecture, code checks and final audit remain separate.'
