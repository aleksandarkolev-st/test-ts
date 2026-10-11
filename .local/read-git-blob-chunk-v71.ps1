param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Blob,
 [ValidateRange(0,2147483647)][int]$Offset=0,
 [ValidateRange(1,12288)][int]$Length=12288
)
$ErrorActionPreference='Stop'
# Read committed bytes, not worktree line-ending conversions or credentials.
$taskInfo=New-Object Diagnostics.ProcessStartInfo
$taskInfo.FileName='git'
$taskInfo.Arguments='cat-file blob '+$Blob
$taskInfo.WorkingDirectory=(Get-Location).Path
$taskInfo.UseShellExecute=$false
$taskInfo.CreateNoWindow=$true
$taskInfo.RedirectStandardOutput=$true
$taskInfo.RedirectStandardError=$true
$taskProcess=New-Object Diagnostics.Process
$taskProcess.StartInfo=$taskInfo
if(!$taskProcess.Start()){throw 'Cannot read committed Git blob'}
$taskMemory=New-Object IO.MemoryStream
try{
 $taskProcess.StandardOutput.BaseStream.CopyTo($taskMemory)
 $taskError=$taskProcess.StandardError.ReadToEnd()
 $taskProcess.WaitForExit()
 if($taskProcess.ExitCode -ne 0){throw $taskError}
 if($taskMemory.Length -gt 8*1024*1024){throw 'Blob exceeds bounded snapshot reader'}
 $taskBytes=$taskMemory.ToArray()
 if($Offset -gt $taskBytes.Length){throw 'Chunk offset exceeds committed blob'}
 $taskCount=[Math]::Min($Length,$taskBytes.Length-$Offset)
 [Console]::Write([Convert]::ToBase64String($taskBytes,$Offset,$taskCount))
}finally{$taskMemory.Dispose();$taskProcess.Dispose()}
