param([string]$TaskRoot='artifacts/deep-interview-v71',[string]$CandidatePath='.local/latest-question-wins')
$ErrorActionPreference='Stop'
$taskWorkspace=(Get-Location).Path
$taskCandidate=(Resolve-Path -LiteralPath $CandidatePath).Path
if(!$taskCandidate.StartsWith($taskWorkspace+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate outside workspace'}
$taskState=Get-Content -LiteralPath ($TaskRoot+'/recording-queue.jsonl') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskState.event -ne 'recordings_terminal'){throw 'Finish baseline capture before architecture comparison'}
$taskControls=Get-Content -LiteralPath ($TaskRoot+'/policy-playback/playback.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($taskControls.status -ne 'complete' -or !$taskControls.stoppedCleanly){throw 'Finish policy controls first'}
$taskManifest=Get-Content -LiteralPath ($TaskRoot+'/policy-playback/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'meeting-copilot.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-backend-playback|record-binary-variant') }
if($taskLive){throw 'Another measured session is active'}
& .\.local\test-question-architecture-v71.ps1 -TaskRoot $TaskRoot -CandidatePath $CandidatePath
$taskOut=$TaskRoot+'/architecture-comparison'
if(Test-Path -LiteralPath ($taskOut+'/comparison.json')){
 $taskPrevious=Get-Content -LiteralPath ($taskOut+'/comparison.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if($taskPrevious.status -ne 'complete' -or !$taskPrevious.stoppedCleanly){throw 'Prior architecture comparison is incomplete; inspect its actual owner before resuming'}
 if($taskPrevious.manifestSha256 -ne (Get-FileHash -LiteralPath ($TaskRoot+'/policy-playback/manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Completed comparison uses a different source manifest'}
 if($taskPrevious.trials.Count -ne $taskManifest.cases.Count*$taskManifest.repetitions*$taskPrevious.variants.Count){throw 'Completed comparison is missing trials'}
 if(!$taskPrevious.protocolTests -or $taskPrevious.protocolTests.sha256 -ne (Get-FileHash -LiteralPath $taskPrevious.protocolTests.file -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Protocol test proof is missing or changed'}
 foreach($taskProperty in $taskPrevious.candidateSourceFiles.PSObject.Properties){
  if($taskProperty.Value -ne (Get-FileHash -LiteralPath (Join-Path $taskCandidate $taskProperty.Name) -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Completed comparison does not validate the current candidate sources'}
 }
 return
}
if(Test-Path -LiteralPath $taskOut){throw 'Prior incomplete comparison preparation retained; inspect before retrying'}
New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
$taskPreparation=Get-Content -LiteralPath ($TaskRoot+'/preparation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskBaseline=$TaskRoot+'/policy-playback/app'
$taskBaselineHash=(Get-FileHash -LiteralPath ($taskBaseline+'/meeting-copilot.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
if($taskBaselineHash -ne ($taskPreparation.sources | Where-Object file -eq 'src-tauri/target/debug/meeting-copilot.exe').sha256){throw 'Archived baseline binary no longer matches hour recordings'}
$taskCandidateSource=[ordered]@{}
$taskFiles=@(Get-ChildItem -LiteralPath (Join-Path $taskCandidate 'src-tauri/src') -Recurse -File | Sort-Object FullName)
$taskFiles+=Get-Item -LiteralPath (Join-Path $taskCandidate 'src-tauri/Cargo.toml'),(Join-Path $taskCandidate 'src-tauri/Cargo.lock'),(Join-Path $taskCandidate 'src-tauri/build.rs')
foreach($taskFile in $taskFiles){
 $taskCandidateSource[$taskFile.FullName.Substring($taskCandidate.Length+1)]=(Get-FileHash -LiteralPath $taskFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$taskFingerprint=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($taskCandidateSource | ConvertTo-Json -Compress)))).Replace('-','').ToLowerInvariant()
$taskTestFile=$TaskRoot+'/candidate-tests/'+$taskFingerprint+'/result.json'
$taskTest=Get-Content -LiteralPath $taskTestFile -Raw -Encoding UTF8 | ConvertFrom-Json
if($taskTest.exitCode -ne 0 -or @($taskTest.sourceChangedDuringCompilation).Count -or $taskTest.sourceFingerprint -ne $taskFingerprint){throw 'Candidate build does not match successful protocol test inputs'}
$taskTestProof=@{file=$taskTestFile;sha256=(Get-FileHash -LiteralPath $taskTestFile -Algorithm SHA256).Hash.ToLowerInvariant();sourceFingerprint=$taskFingerprint}
$taskArguments=@('build','--offline','--manifest-path',('"'+(Join-Path $taskCandidate 'src-tauri/Cargo.toml')+'"'),'--target-dir',('"'+(Join-Path $taskWorkspace 'src-tauri/target')+'"'),'--features','acceptance','--bin','meeting-copilot')
$taskBuild=Start-Process -FilePath 'cargo.exe' -ArgumentList $taskArguments -WorkingDirectory $taskWorkspace -WindowStyle Hidden -PassThru -RedirectStandardOutput ($taskOut+'/build.stdout.log') -RedirectStandardError ($taskOut+'/build.stderr.log') -Wait
if($taskBuild.ExitCode -ne 0){throw ('Candidate build failed; original logs retained in '+$taskOut)}
$taskChanged=@($taskCandidateSource.Keys | Where-Object { (Get-FileHash -LiteralPath (Join-Path $taskCandidate $_) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskCandidateSource[$_] })
if($taskChanged.Count){throw 'Candidate sources changed during build'}
$taskApplication=$taskOut+'/candidate-app'
New-Item -ItemType Directory -Path $taskApplication -Force | Out-Null
Get-ChildItem -LiteralPath src-tauri/target/debug -File | Where-Object { $_.Name -eq 'meeting-copilot.exe' -or $_.Extension -eq '.dll' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $taskApplication }
$taskVariants=@(@{name='baseline';application=$taskBaseline;source='.';binarySha256=$taskBaselineHash},@{name='latest-question-wins';application=$taskApplication;source=$taskCandidate;binarySha256=(Get-FileHash -LiteralPath ($taskApplication+'/meeting-copilot.exe') -Algorithm SHA256).Hash.ToLowerInvariant()})
$taskResult=@{status='in_progress';startedAt=[DateTimeOffset]::UtcNow.ToString('o');ownerPid=$PID;manifestSha256=(Get-FileHash -LiteralPath ($TaskRoot+'/policy-playback/manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant();variants=$taskVariants;candidateSourceFiles=$taskCandidateSource;caseCount=$taskManifest.cases.Count;repetitions=$taskManifest.repetitions;trials=@();goalComplete=$false;independentAccuracyPending=$true;scope='Prospective balanced pairs, identical recorded waveforms and frozen explicit context, existing ASR confirmation policy, fresh meetings. Selected slowest and median source cases are dependent diagnostic examples, not a population sample or hour-long candidate validation. Provider scheduling and transport remain part of observed timing.'}
function Save-Comparison{
 [IO.File]::WriteAllText((Join-Path $taskWorkspace ($taskOut+'/comparison.json')),($taskResult | ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
}
$taskResult.protocolTests=$taskTestProof
$taskResult.build=@{command=$taskArguments;exitCode=$taskBuild.ExitCode;stdout=@{file=$taskOut+'/build.stdout.log';sha256=(Get-FileHash -LiteralPath ($taskOut+'/build.stdout.log') -Algorithm SHA256).Hash.ToLowerInvariant()};stderr=@{file=$taskOut+'/build.stderr.log';sha256=(Get-FileHash -LiteralPath ($taskOut+'/build.stderr.log') -Algorithm SHA256).Hash.ToLowerInvariant()}}
Save-Comparison
try{
 for($taskRep=0;$taskRep -lt $taskManifest.repetitions;$taskRep++){
  for($taskIndex=0;$taskIndex -lt $taskManifest.cases.Count;$taskIndex++){
   $taskOrder=if(($taskRep+$taskIndex)%2){@($taskVariants[1],$taskVariants[0])}else{@($taskVariants[0],$taskVariants[1])}
   foreach($taskVariant in $taskOrder){
    $taskDirectory=$taskOut+'/runs/case-'+$taskIndex+'-rep-'+$taskRep+'-'+$taskVariant.name
    New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
    node --expose-gc --max-old-space-size=6144 .local/record-binary-variant-v71.mjs $TaskRoot $taskVariant.application $taskVariant.source $taskDirectory $taskIndex $taskRep $taskVariant.name
    if($LASTEXITCODE -ne 0){throw ('Architecture trial failed; preserve '+$taskDirectory)}
    $taskTrial=Get-Content -LiteralPath ($taskDirectory+'/playback.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($taskTrial.status -ne 'complete' -or !$taskTrial.stoppedCleanly -or $taskTrial.trials.Count -ne 1){throw 'Architecture trial not clean and complete'}
    if($taskTrial.nativeBinarySha256 -ne $taskVariant.binarySha256){throw 'Measured binary changed'}
    $taskResult.trials+=@{caseIndex=$taskIndex;repetition=$taskRep;variant=$taskVariant.name;playback=$taskDirectory+'/playback.json';playbackSha256=(Get-FileHash -LiteralPath ($taskDirectory+'/playback.json') -Algorithm SHA256).Hash.ToLowerInvariant();recording=$taskTrial.trials[0].outputDirectory+'/interview.json';journalSha256=$taskTrial.trials[0].journalSha256;word=$taskTrial.trials[0].word;error=$taskTrial.trials[0].error;phase=$taskTrial.trials[0].phase}
    Save-Comparison
   }
  }
 }
 if($taskResult.trials.Count -ne $taskManifest.cases.Count*$taskManifest.repetitions*$taskVariants.Count){throw 'Architecture comparison is missing trials'}
 $taskResult.status='complete';$taskResult.stoppedCleanly=$true;$taskResult.completedAt=[DateTimeOffset]::UtcNow.ToString('o');Save-Comparison
}catch{
 $taskResult.status='failed';$taskResult.failure=$_.Exception.Message;$taskResult.completedAt=[DateTimeOffset]::UtcNow.ToString('o');Save-Comparison
 throw
}
