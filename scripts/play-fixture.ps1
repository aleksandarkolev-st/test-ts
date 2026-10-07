param([Parameter(Mandatory=$true)][string]$InputPath, [string]$OutputName)
$ErrorActionPreference='Stop'
if ($OutputName) { & "$PSScriptRoot/play-fixture-device.ps1" -InputPath $InputPath -OutputName $OutputName; return }
$player=New-Object System.Media.SoundPlayer $InputPath
try { $player.PlaySync() } finally { $player.Dispose() }
