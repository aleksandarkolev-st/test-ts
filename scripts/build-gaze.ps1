$ErrorActionPreference = 'Stop'
$copilotRoot = Split-Path -Parent $PSScriptRoot
Push-Location $copilotRoot
$copilotPreviousCache = $env:PYINSTALLER_CONFIG_DIR
try {
    $env:PYINSTALLER_CONFIG_DIR = Join-Path $copilotRoot '.local/pyinstaller-cache'
    if (!(Test-Path -LiteralPath '.local/gaze-runtime/Scripts/python.exe')) { throw 'Run scripts/setup-gaze.ps1 first' }
    & uv pip install --python '.local/gaze-runtime/Scripts/python.exe' --cache-dir '.local/uv-cache' pyinstaller==6.22.3 pyinstaller-hooks-contrib==2026.8 altgraph==0.17.5 pefile==2024.8.26 pywin32-ctypes==0.2.3 setuptools==84.0.0
    if ($LASTEXITCODE -ne 0) { throw 'Cannot install pinned camera packaging dependencies' }
    & '.local/gaze-runtime/Scripts/python.exe' -m PyInstaller --noconfirm --noupx --name gaze-worker --paths scripts --paths camera --collect-all mediapipe --collect-all onnxruntime --collect-all pyvirtualcam --collect-all cv2_enumerate_cameras --copy-metadata numpy --copy-metadata onnxruntime-directml --copy-metadata mediapipe --copy-metadata opencv-contrib-python --copy-metadata pyvirtualcam --copy-metadata cv2-enumerate-cameras --distpath .local/gaze-dist --workpath .local/gaze-build --specpath .local camera/gaze_worker.py
    if ($LASTEXITCODE -ne 0) { throw 'Camera runtime packaging failed' }
    & '.local/gaze-runtime/Scripts/python.exe' 'scripts/gaze-notices.py'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot collect camera notices' }
    & '.local/gaze-dist/gaze-worker/gaze-worker.exe' --list-devices
    if ($LASTEXITCODE -ne 0) { throw 'Packaged camera device discovery failed' }
    Write-Host 'Standalone camera worker ready in .local/gaze-dist/gaze-worker.'
} finally {
    $env:PYINSTALLER_CONFIG_DIR = $copilotPreviousCache
    Pop-Location
}
