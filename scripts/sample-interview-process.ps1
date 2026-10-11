param([Parameter(Mandatory=$true)][int]$ProcessId,[switch]$IncludeDescendants)
$ErrorActionPreference='Stop'
$taskBeforeMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$taskProcess=Get-Process -Id $ProcessId -ErrorAction Stop
$taskRecord=[ordered]@{
 hostMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 processId=$taskProcess.Id
 workingSetBytes=$taskProcess.WorkingSet64
 privateBytes=$taskProcess.PrivateMemorySize64
 cpuSeconds=$taskProcess.TotalProcessorTime.TotalSeconds
 handles=$taskProcess.HandleCount
 threads=$taskProcess.Threads.Count
 scope='Native meeting-copilot process only; excludes separate ASR, Codex, WebView and GPU allocations.'
}
if($IncludeDescendants){
 $taskInventory=@(Get-CimInstance Win32_Process)
 $taskIds=@($ProcessId)
 do{
  $taskNew=@($taskInventory | Where-Object { $_.ParentProcessId -in $taskIds -and $_.ProcessId -notin $taskIds } | Select-Object -ExpandProperty ProcessId)
  $taskIds+=$taskNew
 }while($taskNew.Count -gt 0)
 $taskRows=@(foreach($taskEntry in ($taskInventory | Where-Object ProcessId -in $taskIds)){
  $taskChild=Get-Process -Id $taskEntry.ProcessId -ErrorAction SilentlyContinue
  if($taskChild){[pscustomobject]@{processId=$taskChild.Id;parentProcessId=$taskEntry.ParentProcessId;name=$taskEntry.Name;
   workingSetBytes=$taskChild.WorkingSet64;privateBytes=$taskChild.PrivateMemorySize64;
   cpuSeconds=$taskChild.TotalProcessorTime.TotalSeconds;handles=$taskChild.HandleCount;threads=$taskChild.Threads.Count}}
 })
 $taskRecord.nativeTree=[ordered]@{hostBeforeMs=$taskBeforeMs;hostAfterMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
  rows=$taskRows;nativeTreePrivateBytes=($taskRows | Measure-Object privateBytes -Sum).Sum;
  nativeTreeSumWorkingSetBytes=($taskRows | Measure-Object workingSetBytes -Sum).Sum;
  scope='Native app and current descendants. Working-set sum can double count shared pages. Excludes GPU allocations, pre-existing non-child services and recorder/examiner/playback sibling processes. Processes that exit between samples are not observed.'}
}
[pscustomobject]$taskRecord | ConvertTo-Json -Depth 6 -Compress
