param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference='Stop'
$player=New-Object System.Media.SoundPlayer $InputPath
try { $player.PlaySync() } finally { $player.Dispose() }
