param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$Auditor = (Join-Path $PSScriptRoot '../../artifacts/window-audit/bin/window-audit.exe')
)
$ErrorActionPreference = 'Stop'
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath (Join-Path $taskOutput 'application-windows.json')) { throw 'Choose a fresh process-tree output directory.' }
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
function Get-TaskProcessSnapshot {
    @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate |
        ForEach-Object { [pscustomobject]@{
            pid = [uint32]$_.ProcessId
            parentPid = [uint32]$_.ParentProcessId
            name = $_.Name
            executablePath = $_.ExecutablePath
            createdAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })
        } })
}
$taskBeforeTime = [DateTime]::UtcNow.ToString('o')
$taskBefore = Get-TaskProcessSnapshot
$taskRootBefore = @($taskBefore | Where-Object pid -eq $RootProcessId)
if ($taskRootBefore.Count -ne 1) { throw 'The root process is not running.' }
$taskRawPath = Join-Path $taskOutput 'all-windows.json'
& $Auditor --all --output $taskRawPath
if ($LASTEXITCODE -ne 0) { throw "Native window enumeration failed: $LASTEXITCODE" }
$taskAfter = Get-TaskProcessSnapshot
$taskAfterTime = [DateTime]::UtcNow.ToString('o')
$taskRootAfter = @($taskAfter | Where-Object pid -eq $RootProcessId)
if ($taskRootAfter.Count -ne 1 -or $taskRootAfter[0].createdAt -ne $taskRootBefore[0].createdAt) {
    throw 'The application exited or the root PID was reused during enumeration.'
}
$taskProcessMap = @{}
foreach ($taskProcess in @($taskBefore) + @($taskAfter)) {
    $taskKey = "$($taskProcess.pid):$($taskProcess.createdAt)"
    $taskProcessMap[$taskKey] = $taskProcess
}
$taskTree = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$taskTree.Add([uint32]$RootProcessId)
$taskSelected = @{}
$taskSelected["$RootProcessId"] = $taskRootBefore[0]
do {
    $taskChanged = $false
    foreach ($taskProcess in $taskProcessMap.Values) {
        if (-not $taskTree.Contains($taskProcess.parentPid)) { continue }
        $taskParent = $taskSelected["$($taskProcess.parentPid)"]
        if ($taskProcess.createdAt -and $taskParent.createdAt -and $taskProcess.createdAt -lt $taskParent.createdAt) { continue }
        if ($taskTree.Add($taskProcess.pid)) {
            $taskSelected["$($taskProcess.pid)"] = $taskProcess
            $taskChanged = $true
        }
    }
} while ($taskChanged)
$taskRaw = Get-Content -LiteralPath $taskRawPath -Raw | ConvertFrom-Json
if ($taskRaw.truncated) { throw 'Native window enumeration was truncated.' }
$taskWindowMap = @{}
foreach ($taskWindow in $taskRaw.windows) { $taskWindowMap[$taskWindow.hwnd] = $taskWindow }
$taskIncluded = [System.Collections.Generic.HashSet[string]]::new()
foreach ($taskWindow in $taskRaw.windows) {
    if ($taskTree.Contains([uint32]$taskWindow.pid)) { [void]$taskIncluded.Add($taskWindow.hwnd) }
}
do {
    $taskChanged = $false
    foreach ($taskHandle in @($taskIncluded)) {
        $taskWindow = $taskWindowMap[$taskHandle]
        foreach ($taskRelation in @($taskWindow.parent, $taskWindow.owner)) {
            if ($taskWindowMap.ContainsKey($taskRelation) -and $taskIncluded.Add($taskRelation)) { $taskChanged = $true }
        }
    }
} while ($taskChanged)
$taskWindows = @($taskRaw.windows | Where-Object { $taskIncluded.Contains($_.hwnd) } | ForEach-Object {
    $_ | Add-Member -NotePropertyName isTargetPid -NotePropertyValue ($_.pid -eq $RootProcessId) -Force
    $_ | Add-Member -NotePropertyName isApplicationProcess -NotePropertyValue $taskTree.Contains([uint32]$_.pid) -Force
    $_ | Add-Member -NotePropertyName isRelationContext -NotePropertyValue (-not $taskTree.Contains([uint32]$_.pid)) -Force
    $_
})
$taskAppWindows = @($taskWindows | Where-Object isApplicationProcess)
$taskReport = [ordered]@{
    schemaVersion = 1
    kind = 'whole-application-window-audit'
    sampledBefore = $taskBeforeTime
    sampledAfter = $taskAfterTime
    rootProcessId = $RootProcessId
    rootIdentity = $taskRootBefore[0]
    observerPid = $taskRaw.observerPid
    applicationProcessIds = @($taskTree | Sort-Object)
    processTree = @($taskSelected.Values | Sort-Object pid)
    processSnapshotBefore = @($taskBefore | Where-Object { $taskTree.Contains($_.pid) })
    processSnapshotAfter = @($taskAfter | Where-Object { $taskTree.Contains($_.pid) })
    applicationWindowCount = $taskAppWindows.Count
    rootPidWindowCount = @($taskAppWindows | Where-Object pid -eq $RootProcessId).Count
    descendantProcessWindowCount = @($taskAppWindows | Where-Object pid -ne $RootProcessId).Count
    relationContextWindowCount = $taskWindows.Count - $taskAppWindows.Count
    nativeRawWindowCount = $taskRaw.reportedWindowCountIncludingRelations
    enumerationCalls = $taskRaw.enumerationCalls
    rawSnapshot = 'all-windows.json'
    windows = $taskWindows
    limits = @(
        'Process and window snapshots are not atomic; short-lived descendants can be missed.'
        'Descendants are linked by parent PID and creation time from snapshots before and after window enumeration.'
        'The scan covers accessible desktops of the current window station, not every privileged observer.'
        'Titles and executable paths are stored locally; this script uploads nothing.'
    )
}
$taskReport | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $taskOutput 'application-windows.json') -Encoding UTF8
Write-Output "Application tree: $($taskTree.Count) processes, $($taskAppWindows.Count) HWNDs ($($taskReport.descendantProcessWindowCount) in descendant processes)."
