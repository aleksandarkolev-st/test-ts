param([string]$TaskRoot='artifacts/deep-interview-v71')
$ErrorActionPreference='Stop'
$taskWorkspace=(Get-Location).Path
$taskOutput=Join-Path $taskWorkspace ($TaskRoot+'/cuda-compiler')
if(!$taskOutput.StartsWith($taskWorkspace+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Compiler resources must remain in the workspace'}
$taskState=Get-Content -LiteralPath ($TaskRoot+'/recording-queue.jsonl') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
if($taskState.event -ne 'recordings_terminal'){throw 'Finish measured capture before preparing compiler resources'}
$taskLive=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'meeting-copilot.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'native-signed-interview|record-backend-playback|record-binary-variant') }
if($taskLive){throw 'A measured native session is still active'}
$taskProof=Join-Path $taskOutput 'toolchain.json'
if(Test-Path -LiteralPath $taskProof){
 $taskPrevious=Get-Content -LiteralPath $taskProof -Raw -Encoding UTF8 | ConvertFrom-Json
 foreach($taskFile in $taskPrevious.files){if($taskFile.sha256 -ne (Get-FileHash -LiteralPath $taskFile.file -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Prepared compiler resources changed'}}
 return
}
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskManifestUrl='https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json'
$taskManifestFile=Join-Path $taskOutput 'redistrib_12.9.1.json'
if(!(Test-Path -LiteralPath $taskManifestFile)){Invoke-WebRequest -UseBasicParsing -Uri $taskManifestUrl -OutFile $taskManifestFile}
$taskManifest=Get-Content -LiteralPath $taskManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
if($taskManifest.release_label -ne '12.9.1'){throw 'Unexpected pinned compiler manifest'}
$taskComponents=@()
foreach($taskName in @('cuda_nvcc','cuda_cudart','cuda_cccl')){
 $taskComponent=$taskManifest.$taskName
 $taskPackage=$taskComponent.'windows-x86_64'
 if(!$taskPackage -or $taskPackage.relative_path -notmatch '^[a-z0-9_./-]+\.zip$' -or $taskPackage.relative_path.Split('/') -contains '..'){throw 'Invalid component manifest path'}
 $taskZip=Join-Path $taskOutput ([IO.Path]::GetFileName($taskPackage.relative_path))
 if(!(Test-Path -LiteralPath $taskZip)){Invoke-WebRequest -UseBasicParsing -Uri ('https://developer.download.nvidia.com/compute/cuda/redist/'+$taskPackage.relative_path) -OutFile $taskZip}
 if((Get-Item -LiteralPath $taskZip).Length -ne [long]$taskPackage.size -or (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskPackage.sha256){throw 'Component bytes do not match NVIDIA manifest; preserve and inspect the download'}
 $taskExtract=Join-Path $taskOutput $taskName
 if(!(Test-Path -LiteralPath $taskExtract)){
  Expand-Archive -LiteralPath $taskZip -DestinationPath $taskExtract
 }
 $taskRoots=@(Get-ChildItem -LiteralPath $taskExtract -Directory)
 if($taskRoots.Count -ne 1){throw 'Unexpected component archive layout'}
 $taskComponents+=@{name=$taskName;version=$taskComponent.version;root=$taskRoots[0].FullName;archive=$taskZip;sha256=$taskPackage.sha256;size=[long]$taskPackage.size;url='https://developer.download.nvidia.com/compute/cuda/redist/'+$taskPackage.relative_path}
}
$taskVswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$taskHost=@(& $taskVswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe') | Select-Object -Last 1
if(!$taskHost){throw 'MSVC host compiler unavailable'}
$taskNvcc=Join-Path ($taskComponents | Where-Object name -eq 'cuda_nvcc').root 'bin/nvcc.exe'
if(!(Test-Path -LiteralPath $taskNvcc)){throw 'Pinned nvcc executable missing'}
$taskFiles=@(@{file=$taskManifestFile;sha256=(Get-FileHash -LiteralPath $taskManifestFile -Algorithm SHA256).Hash.ToLowerInvariant()})
foreach($taskComponent in $taskComponents){
 $taskFiles+=@{file=$taskComponent.archive;sha256=$taskComponent.sha256}
 $taskFiles+=Get-ChildItem -LiteralPath $taskComponent.root -Recurse -File | Sort-Object FullName | ForEach-Object { @{file=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} }
}
$taskResult=@{recordedAt=[DateTimeOffset]::UtcNow.ToString('o');manifestUrl=$taskManifestUrl;manifestSha256=(Get-FileHash -LiteralPath $taskManifestFile -Algorithm SHA256).Hash.ToLowerInvariant();release='12.9.1';nvcc=$taskNvcc;hostCompiler=$taskHost;hostCompilerSha256=(Get-FileHash -LiteralPath $taskHost -Algorithm SHA256).Hash.ToLowerInvariant();components=$taskComponents;files=$taskFiles;scope='Workspace-local NVIDIA compiler and header component archives, pinned to CUDA 12.9 supporting the required sm_70 target. No GPU driver or system toolkit installation, no hardware execution, and no capture latency measurement.'}
[IO.File]::WriteAllText($taskProof,($taskResult | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
Write-Output ('CUDA compiler resources prepared: '+$taskProof)
