param(
    [Parameter(Mandatory = $true)][string]$TargetHwnd,
    [Parameter(Mandatory = $true)][string]$ReferenceDirectory,
    [Parameter(Mandatory = $true)][string]$ControlFile,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Prefix,
    [Parameter(Mandatory = $true)][ValidateSet('hidden', 'shown')][string]$ExpectedVisibility,
    [string]$Auditor = (Join-Path $PSScriptRoot '../../artifacts/window-audit/bin/window-audit.exe')
)
$ErrorActionPreference = 'Stop'
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$taskStatusFile = Join-Path ([System.IO.Path]::GetFullPath($ReferenceDirectory)) 'status.json'
$taskControl = [System.IO.Path]::GetFullPath($ControlFile)
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
foreach ($taskPhase in 0, 1, 2) {
    [System.IO.File]::WriteAllText($taskControl, "$taskPhase`n", [System.Text.Encoding]::ASCII)
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 50
        $taskStatus = Get-Content -LiteralPath $taskStatusFile -Raw | ConvertFrom-Json
        if ($taskStatus.state -ne 'running') { throw 'Reference background stopped.' }
    } while ($taskStatus.phase -ne $taskPhase -and [DateTime]::UtcNow -lt $taskDeadline)
    if ($taskStatus.phase -ne $taskPhase) { throw 'Reference phase acknowledgement timed out.' }
    if ($taskStatus.targetHwnd -ne $TargetHwnd) { throw 'Reference target does not match the requested application HWND.' }
    if ([bool]$taskStatus.target.visible -ne ($ExpectedVisibility -eq 'shown')) { throw 'Actual overlay visibility differs from requested capture state.' }
    if (-not $taskStatus.targetImmediatelyPrecedesReference -or -not $taskStatus.refreshStripOnMonitor) {
        throw 'Reference z-order or visible refresh strip is unverified.'
    }
    Start-Sleep -Milliseconds 180
    $taskName = "$Prefix-phase$taskPhase"
    Copy-Item -LiteralPath $taskStatusFile -Destination (Join-Path $taskOutput "$taskName-reference.json")
    & $Auditor --capture-real --hwnd $TargetHwnd --phase $taskPhase --origin "$($taskStatus.origin.x),$($taskStatus.origin.y)" --output $taskOutput --prefix $taskName
    if ($LASTEXITCODE -ne 0) { throw "Native capture failed: $LASTEXITCODE" }
    $taskAfter = Get-Content -LiteralPath $taskStatusFile -Raw | ConvertFrom-Json
    Copy-Item -LiteralPath $taskStatusFile -Destination (Join-Path $taskOutput "$taskName-reference-after.json")
    if ($taskAfter.phase -ne $taskPhase -or $taskAfter.origin.x -ne $taskStatus.origin.x -or $taskAfter.origin.y -ne $taskStatus.origin.y) {
        throw 'Reference changed while capturing; retain evidence and repeat with a fresh prefix.'
    }
}
