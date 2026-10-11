param([Parameter(Mandatory=$true)][string[]]$Arguments,[Parameter(Mandatory=$true)][string]$WorkingDirectory,[Parameter(Mandatory=$true)][string]$Stdout,[Parameter(Mandatory=$true)][string]$Stderr)
$ErrorActionPreference='Stop'
$taskWorkspace=(Get-Location).Path
foreach($taskPath in @($WorkingDirectory,$Stdout,$Stderr)){
 $taskResolved=[IO.Path]::GetFullPath($taskPath)
 if($taskResolved -ne $taskWorkspace -and !$taskResolved.StartsWith($taskWorkspace+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Cargo capture paths must remain in the workspace'}
}
$taskInfo=New-Object Diagnostics.ProcessStartInfo
$taskInfo.FileName='cargo.exe'
# Windows argv quoting; no shell evaluates these arguments.
$taskInfo.Arguments=(@($Arguments | ForEach-Object { '"'+[regex]::Replace([regex]::Replace($_,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"' }) -join ' ')
$taskInfo.WorkingDirectory=[IO.Path]::GetFullPath($WorkingDirectory)
$taskInfo.UseShellExecute=$false
$taskInfo.CreateNoWindow=$true
$taskInfo.RedirectStandardOutput=$true
$taskInfo.RedirectStandardError=$true
$taskProcess=New-Object Diagnostics.Process
$taskProcess.StartInfo=$taskInfo
$taskOut=$null;$taskErr=$null
try{
 $taskOut=[IO.File]::Open([IO.Path]::GetFullPath($Stdout),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 $taskErr=[IO.File]::Open([IO.Path]::GetFullPath($Stderr),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 $taskStarted=[DateTimeOffset]::UtcNow.ToString('o')
 if(!$taskProcess.Start()){throw 'Could not start cargo'}
 $taskOutCopy=$taskProcess.StandardOutput.BaseStream.CopyToAsync($taskOut)
 $taskErrCopy=$taskProcess.StandardError.BaseStream.CopyToAsync($taskErr)
 $taskProcess.WaitForExit()
 [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($taskOutCopy,$taskErrCopy))
 [pscustomobject]@{Id=$taskProcess.Id;ExitCode=$taskProcess.ExitCode;startedAt=$taskStarted;completedAt=[DateTimeOffset]::UtcNow.ToString('o')}
}finally{if($taskOut){$taskOut.Dispose()};if($taskErr){$taskErr.Dispose()};$taskProcess.Dispose()}
