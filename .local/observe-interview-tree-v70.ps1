param([int]$NativeProcessId=30468,[int]$RunnerProcessId=38628)
$ErrorActionPreference='Stop'
$taskOutput=Join-Path (Get-Location).Path 'artifacts/deep-interview-v70/algorithms-hour-t/process-tree-resources.jsonl'
if(Test-Path -LiteralPath $taskOutput){throw 'Refusing to overwrite resource observations'}
$taskRoot=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$NativeProcessId)
if($taskRoot.Name -ne 'meeting-copilot.exe' -or $taskRoot.ParentProcessId -ne $RunnerProcessId){throw 'Unexpected measured process identity'}
$taskCreation=$taskRoot.CreationDate
$taskCount=0
while($true){
 $taskStarted=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 $taskProcesses=@(Get-CimInstance Win32_Process)
 $taskCurrent=$taskProcesses | Where-Object ProcessId -eq $NativeProcessId
 if(!$taskCurrent -or $taskCurrent.CreationDate -ne $taskCreation){break}
 $taskIds=@($NativeProcessId)
 do{
  $taskNew=@($taskProcesses | Where-Object { $_.ParentProcessId -in $taskIds -and $_.ProcessId -notin $taskIds } | Select-Object -ExpandProperty ProcessId)
  $taskIds+= $taskNew
 }while($taskNew.Count -gt 0)
 $taskRows=@()
 foreach($taskEntry in ($taskProcesses | Where-Object ProcessId -in ($taskIds+@($RunnerProcessId)))){
  $taskP=Get-Process -Id $taskEntry.ProcessId -ErrorAction SilentlyContinue
  if($taskP){$taskRows+=[pscustomobject]@{processId=$taskP.Id;parentProcessId=$taskEntry.ParentProcessId;name=$taskEntry.Name;
   nativeTree=($taskP.Id -in $taskIds);workingSetBytes=$taskP.WorkingSet64;privateBytes=$taskP.PrivateMemorySize64;
   cpuSeconds=$taskP.TotalProcessorTime.TotalSeconds;handles=$taskP.HandleCount;threads=$taskP.Threads.Count}}
 }
 $taskTree=@($taskRows | Where-Object nativeTree)
 $taskRecord=[pscustomobject]@{hostBeforeMs=$taskStarted;hostAfterMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
  nativeProcessId=$NativeProcessId;nativeCreationDate=$taskCreation.ToUniversalTime().ToString('o');rows=$taskRows;
  nativeTreePrivateBytes=($taskTree | Measure-Object privateBytes -Sum).Sum;
  nativeTreeSumWorkingSetBytes=($taskTree | Measure-Object workingSetBytes -Sum).Sum;
  scope='Read-only native process tree plus recorder. Working-set sum may count shared pages more than once. GPU allocations and pre-existing non-child services are excluded. This observer starts mid-interview; it cannot reconstruct startup resource use.'}
 $taskRecord | ConvertTo-Json -Depth 6 -Compress | Add-Content -LiteralPath $taskOutput -Encoding UTF8
 if($taskCount%4 -eq 0){Write-Output ('Resource observation '+$taskCount+': '+$taskTree.Count+' native-tree processes, '+[math]::Round($taskRecord.nativeTreePrivateBytes/1MB,1)+' MiB private allocations')}
 $taskCount++
 Start-Sleep -Seconds 15
}
Write-Output 'Measured native process has exited; resource observation stopped.'
