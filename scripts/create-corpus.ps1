$ErrorActionPreference='Stop'
$taskRoot=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskCorpus=Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'tests/fixtures/utterances.json') | ConvertFrom-Json
$taskOut=Join-Path $taskRoot '.local/audio/corpus'
New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
Add-Type -AssemblyName System.Speech
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voices=@($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' })
    if ($voices.Count -eq 0) { throw 'An installed English Windows speech voice is required' }
    $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
    for ($i=0; $i -lt $taskCorpus.Count; $i++) {
        $synth.SelectVoice($voices[$i % $voices.Count].VoiceInfo.Name)
        $synth.Rate=($i % 3)-1
        $synth.SetOutputToWaveFile((Join-Path $taskOut ($i.ToString('D3')+'.wav')),$format)
        $synth.Speak($taskCorpus[$i].text)
        $synth.SetOutputToNull()
    }
    Write-Output ('Generated '+$taskCorpus.Count+' synthetic speech fixtures with '+$voices.Count+' English voices.')
} finally { $synth.Dispose() }
