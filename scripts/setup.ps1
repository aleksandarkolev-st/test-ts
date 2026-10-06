param([switch]$SkipModel)
$ErrorActionPreference='Stop'
$root=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $root
try {
    New-Item -ItemType Directory -Force .local,models | Out-Null
    python -m pip download libclang==18.1.1 --no-deps --dest .local --index-url https://pypi.org/simple
    if ($LASTEXITCODE -ne 0) { throw 'libclang download failed' }
    python -c "import zipfile; zipfile.ZipFile('.local/libclang-18.1.1-py2.py3-none-win_amd64.whl').extractall('.local/libclang')"
    if ($LASTEXITCODE -ne 0) { throw 'libclang extraction failed' }
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    cargo --config net.offline=false fetch --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Cargo fetch failed' }
    if (-not $SkipModel) {
        $modelPath=Join-Path $root 'models/ggml-tiny.en.bin'
        $expected='921E4CF8686FDD993DCD081A5DA5B6C365BFDE1162E72B08D75AC75289920B1F'
        if (-not (Test-Path -LiteralPath $modelPath) -or (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash -ne $expected) {
            curl.exe -L --fail --connect-timeout 15 --max-time 300 --output $modelPath 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin'
            if ($LASTEXITCODE -ne 0) { throw 'Whisper model download failed' }
        }
        if ((Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash -ne $expected) { throw 'Whisper model checksum mismatch' }
    }
} finally { Pop-Location }
