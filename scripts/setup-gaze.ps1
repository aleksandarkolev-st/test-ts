param([int]$Device = -1)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$copilotRoot = Split-Path -Parent $PSScriptRoot
Push-Location $copilotRoot
try {
    New-Item -ItemType Directory -Force -Path '.local','models/gaze' | Out-Null
    function Get-GazeArtifact([string]$Uri,[string]$Destination,[string]$Sha256) {
        if ((Test-Path -LiteralPath $Destination) -and ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256)) { return }
        $copilotDownload = "$Destination.download"
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $copilotDownload -TimeoutSec 600
        if ((Get-FileHash -LiteralPath $copilotDownload -Algorithm SHA256).Hash -ne $Sha256) { throw "SHA-256 mismatch: $Destination" }
        Move-Item -LiteralPath $copilotDownload -Destination $Destination -Force
    }
    Get-GazeArtifact 'https://github.com/WangWilly/gaze-correction-cam/releases/download/v0.1.1/weights.zip' '.local/gaze-weights.zip' '07279dd9072f784e32c26e0c40bdf10270f98c6f3e9b3effc3254c4ce05fa76a'
    Expand-Archive -LiteralPath '.local/gaze-weights.zip' -DestinationPath '.local/gaze-weights' -Force
    Get-GazeArtifact 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' 'models/gaze/face_landmarker.task' '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'
    & uv venv '.local/gaze-convert' --python 3.11 --cache-dir '.local/uv-cache' --allow-existing
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create gaze converter environment' }
    & uv pip install --python '.local/gaze-convert/Scripts/python.exe' --cache-dir '.local/uv-cache' tensorflow==2.15.1 tf2onnx==1.16.1 onnx==1.16.2 onnxruntime-directml==1.24.4 numpy==1.26.4
    if ($LASTEXITCODE -ne 0) { throw 'Cannot install gaze converter dependencies' }
    $copilotExportArguments = @('scripts/export-gaze.py')
    if ($Device -ge 0) { $copilotExportArguments += @('--device', [string]$Device) }
    & '.local/gaze-convert/Scripts/python.exe' @copilotExportArguments
    if ($LASTEXITCODE -ne 0) { throw 'FLX export or trained-graph parity failed' }
    & uv venv '.local/gaze-runtime' --python 3.11 --cache-dir '.local/uv-cache' --allow-existing
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create camera environment' }
    & uv pip install --python '.local/gaze-runtime/Scripts/python.exe' --cache-dir '.local/uv-cache' numpy==1.26.4 onnxruntime-directml==1.24.4 opencv-contrib-python==4.11.0.86 mediapipe==0.10.32 pyvirtualcam==0.15.0 cv2-enumerate-cameras==1.4.0
    if ($LASTEXITCODE -ne 0) { throw 'Cannot install camera dependencies' }
    Write-Host 'Local FLX models exported and checked against their original graphs. Numeric evidence: artifacts/gaze/export-parity.json.'
} finally { Pop-Location }
