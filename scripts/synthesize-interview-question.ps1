param(
    [Parameter(Mandatory=$true)][string]$TextPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [int]$PauseAfterCharacters = 0,
    [int]$PauseMs = 700
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$questionText=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $TextPath),[Text.Encoding]::UTF8)
$speaker=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $englishVoice=$speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
    if (-not $englishVoice) { throw 'An installed English speech voice is required' }
    $speaker.SelectVoice($englishVoice.VoiceInfo.Name)
    $format=[System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
    $speaker.SetOutputToWaveFile([IO.Path]::GetFullPath($OutputPath),$format)
    if ($PauseAfterCharacters -gt 0 -and $PauseAfterCharacters -lt $questionText.Length) {
        $before=[Security.SecurityElement]::Escape($questionText.Substring(0,$PauseAfterCharacters))
        $after=[Security.SecurityElement]::Escape($questionText.Substring($PauseAfterCharacters))
        $speaker.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'+$before+'<break time="'+$PauseMs+'ms"/>'+$after+'</speak>')
    } else { $speaker.Speak($questionText) }
    $speaker.SetOutputToNull()
    Write-Output $englishVoice.VoiceInfo.Name
} finally { $speaker.Dispose() }
