param([string]$Workspace = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$codexVersion = '0.160.1'
$codexHash = '9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d'
$codexRoot = Join-Path $Workspace '.local/codex'
New-Item -ItemType Directory -Path $codexRoot -Force | Out-Null
$codexBinary = Join-Path $codexRoot 'codex.exe'
if (-not (Test-Path -LiteralPath $codexBinary)) {
    $installedCodex = Join-Path $env:APPDATA 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
    if ((Test-Path -LiteralPath $installedCodex) -and (Get-FileHash -LiteralPath $installedCodex -Algorithm SHA256).Hash.ToLowerInvariant() -eq $codexHash) {
        Copy-Item -LiteralPath $installedCodex -Destination $codexBinary
    } else {
        $codexDownload = Join-Path $Workspace '.local/codex-download'
        New-Item -ItemType Directory -Path $codexDownload -Force | Out-Null
        & npm.cmd pack "@openai/codex@$codexVersion-win32-x64" --pack-destination $codexDownload
        if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex download failed' }
        $codexArchive = Join-Path $codexDownload "openai-codex-$codexVersion-win32-x64.tgz"
        & tar.exe -xf $codexArchive -C $codexDownload
        if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex extraction failed' }
        Copy-Item -LiteralPath (Join-Path $codexDownload 'package/vendor/x86_64-pc-windows-msvc/bin/codex.exe') -Destination $codexBinary
    }
}
if ((Get-FileHash -LiteralPath $codexBinary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $codexHash) { throw 'Codex binary checksum mismatch' }
$codexNotices = @(
    @{File='LICENSE.txt'; Source='LICENSE'; Hash='d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'},
    @{File='NOTICE.txt'; Source='NOTICE'; Hash='9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'}
)
foreach ($notice in $codexNotices) {
    $noticeTarget = Join-Path $codexRoot $notice.File
    if (-not (Test-Path -LiteralPath $noticeTarget)) {
        & curl.exe --max-time 30 --fail --location --silent --show-error "https://raw.githubusercontent.com/openai/codex/rust-v$codexVersion/$($notice.Source)" --output $noticeTarget
        if ($LASTEXITCODE -ne 0) { throw "Codex $($notice.Source) download failed" }
    }
    if ((Get-FileHash -LiteralPath $noticeTarget -Algorithm SHA256).Hash.ToLowerInvariant() -ne $notice.Hash) { throw "Codex $($notice.Source) checksum mismatch" }
}
@{version=$codexVersion;binarySha256=$codexHash;source="https://github.com/openai/codex/tree/rust-v$codexVersion";license='Apache-2.0';authentication='Native Codex account; credentials are never copied into these resources'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $codexRoot 'manifest.json') -Encoding utf8
Write-Output "Pinned Codex $codexVersion runtime and original notices verified."
