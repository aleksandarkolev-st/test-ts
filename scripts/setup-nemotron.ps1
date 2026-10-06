param([switch]$RuntimeOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$copilotRoot = Split-Path -Parent $PSScriptRoot
$copilotRuntime = Join-Path $copilotRoot '.local/nemotron'
$copilotModels = Join-Path $copilotRoot 'models'
New-Item -ItemType Directory -Force -Path $copilotRuntime,$copilotModels | Out-Null

# Pinned official Windows Vulkan release and official English Q8 model.
# The hashes were read from NVIDIA's release checksum and HF LFS metadata.
function Get-VerifiedArtifact([string]$Uri,[string]$Destination,[string]$Sha256) {
    if ((Test-Path -LiteralPath $Destination) -and ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256)) { return }
    $copilotDownload = "$Destination.download"
    Write-Host "Downloading $(Split-Path -Leaf $Destination)..."
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $copilotDownload -TimeoutSec 600
    if ((Get-FileHash -LiteralPath $copilotDownload -Algorithm SHA256).Hash -ne $Sha256) { throw "SHA-256 mismatch: $Destination" }
    Move-Item -LiteralPath $copilotDownload -Destination $Destination -Force
}
$copilotArchive = Join-Path $copilotRuntime 'nemo-speech-0.2.0-windows-x86_64-vulkan.zip'
Get-VerifiedArtifact 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-windows-x86_64-vulkan.zip' $copilotArchive 'edf15a04ba98740aa0ab75ae4681ac7ad0a488b22b35ce2cbebd10590bb1c1e1'
Expand-Archive -LiteralPath $copilotArchive -DestinationPath $copilotRuntime -Force
if (!$RuntimeOnly) {
    Get-VerifiedArtifact 'https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/ebe59e5a817142986528bbbee5dba8db7b38ed50/nemotron-speech-streaming-en-0.6b.q8_0.gguf' (Join-Path $copilotModels 'nemotron-speech-streaming-en-0.6b.q8_0.gguf') 'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'
}
Write-Host 'Verified Nemotron runtime is ready under .local/nemotron. No user PATH or global installation was changed.'
