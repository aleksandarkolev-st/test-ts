param([string]$TaskRoot='artifacts/deep-interview-v71',[string]$CandidatePath='.local/latest-question-wins')
$ErrorActionPreference='Stop'
$taskWorkspace=(Get-Location).Path
$taskCandidate=(Resolve-Path -LiteralPath $CandidatePath).Path
if(!$taskCandidate.StartsWith($taskWorkspace+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate must remain in this workspace'}
$taskState=Get-Content -LiteralPath ($TaskRoot+'/recording-queue.jsonl') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskState.event -ne 'recordings_terminal'){throw 'Finish baseline captures before compiling the candidate'}
$taskControl=Get-Content -LiteralPath ($TaskRoot+'/policy-playback/playback.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($taskControl.status -ne 'complete' -or !$taskControl.stoppedCleanly){throw 'Finish policy playback before compiling the candidate'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'meeting-copilot.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-backend-playback') }
if($taskLive){throw 'Refusing compilation during measured native capture'}
$taskSource=Join-Path $taskCandidate 'src-tauri/src/openai/codex.rs'
$taskSourceHash=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()
$taskSourceManifest=[ordered]@{}
$taskFiles=@(Get-ChildItem -LiteralPath (Join-Path $taskCandidate 'src-tauri/src') -Recurse -File | Sort-Object FullName)
$taskFiles+=Get-Item -LiteralPath (Join-Path $taskCandidate 'src-tauri/Cargo.toml'),(Join-Path $taskCandidate 'src-tauri/Cargo.lock'),(Join-Path $taskCandidate 'src-tauri/build.rs')
foreach($taskFile in $taskFiles){$taskSourceManifest[$taskFile.FullName.Substring($taskCandidate.Length+1)]=(Get-FileHash -LiteralPath $taskFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
$taskFingerprint=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($taskSourceManifest | ConvertTo-Json -Compress)))).Replace('-','').ToLowerInvariant()
$taskOutput=Join-Path $TaskRoot ('candidate-tests/'+$taskFingerprint)
if(Test-Path -LiteralPath ($taskOutput+'/result.json')){
 $taskPrevious=Get-Content -LiteralPath ($taskOutput+'/result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if($taskPrevious.exitCode -ne 0 -or @($taskPrevious.sourceChangedDuringCompilation).Count){throw 'Prior candidate test failure or changing-source result retained; inspect before retrying'}
 return
}
if(Test-Path -LiteralPath $taskOutput){throw 'Prior incomplete candidate test attempt retained; inspect its owner before retrying'}
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
# Reuse local runtime resources without duplicating models or modifying sources.
foreach($taskResource in @('models','dist','.local/codex','.local/nemotron','.local/gaze-dist')){
 $taskTarget=Join-Path $taskCandidate $taskResource
 $taskOriginal=Join-Path $taskWorkspace $taskResource
 if((Test-Path -LiteralPath $taskOriginal) -and !(Test-Path -LiteralPath $taskTarget)){
  New-Item -ItemType Junction -Path $taskTarget -Target $taskOriginal | Out-Null
 }
}
$taskStarted=[DateTimeOffset]::UtcNow.ToString('o')
$taskManifest=Join-Path $taskCandidate 'src-tauri/Cargo.toml'
$taskTargetDir=Join-Path $taskWorkspace 'src-tauri/target'
$taskArguments=@('test','--offline','--manifest-path',$taskManifest,'--target-dir',$taskTargetDir,'--features','acceptance','--lib','openai::codex::tests::','--','--skip','live_','--test-threads=1')
$taskProcess=& .\.local\invoke-cargo-capture-v71.ps1 -Arguments $taskArguments -WorkingDirectory $taskWorkspace -Stdout ($taskOutput+'/stdout.log') -Stderr ($taskOutput+'/stderr.log')
$taskChanged=@($taskSourceManifest.Keys | Where-Object { (Get-FileHash -LiteralPath (Join-Path $taskCandidate $_) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskSourceManifest[$_] })
$taskResult=@{startedAt=$taskStarted;completedAt=[DateTimeOffset]::UtcNow.ToString('o');candidate=$taskCandidate;sourceSha256=$taskSourceHash;sourceFingerprint=$taskFingerprint;sourceFiles=$taskSourceManifest;sourceChangedDuringCompilation=$taskChanged;processId=$taskProcess.Id;exitCode=$taskProcess.ExitCode;command=$taskArguments;goalComplete=$false;scope='Real candidate crate compilation and non-live Codex protocol tests. No provider, accuracy, audio or latency improvement certification.'}
[IO.File]::WriteAllText((Join-Path $taskWorkspace ($taskOutput+'/result.json')),($taskResult | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
if($taskChanged.Count){throw 'Candidate sources changed during compilation; result cannot certify the current sources'}
if($taskProcess.ExitCode -ne 0){throw ('Candidate protocol tests failed; inspect '+$taskOutput)}
Write-Output ('Candidate protocol tests passed: '+$taskOutput)
