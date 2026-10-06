param([string]$Output='.local/audio/remote-question.wav',[string]$Text='What is our launch target for next quarter?')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$fixturePath=[System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Output))
$workspacePath=[System.IO.Path]::GetFullPath((Get-Location).Path)
if (-not $fixturePath.StartsWith($workspacePath+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture output must remain in this workspace' }
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($fixturePath)) | Out-Null
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($fixturePath,$format)
    $synth.Speak($Text)
} finally { $synth.Dispose() }
Write-Output 'Generated a synthetic local English speech fixture.'
