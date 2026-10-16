param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../../artifacts/window-audit/bin'))
$ErrorActionPreference = 'Stop'
$taskVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $taskVsWhere)) { throw 'Install Visual Studio C++ build tools and a Windows 11 SDK.' }
$taskVsPath = & $taskVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVsPath) { throw 'No Visual Studio x64 C++ toolchain found.' }
$taskVcRoot = Get-ChildItem -LiteralPath (Join-Path $taskVsPath 'VC/Tools/MSVC') -Directory |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 -ExpandProperty FullName
$taskSdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$taskSdkVersion = Get-ChildItem -LiteralPath (Join-Path $taskSdkRoot 'Include') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'cppwinrt/winrt/base.h') } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 -ExpandProperty Name
if (-not $taskSdkVersion) { throw 'A recent Windows SDK with C++/WinRT is required.' }
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskOldPath = $env:PATH
$taskOldInclude = $env:INCLUDE
$taskOldLib = $env:LIB
$taskSources = @('main.cpp', 'audit.cpp', 'capture.cpp', 'fixture.cpp', 'real-app.cpp') | ForEach-Object { Join-Path $PSScriptRoot $_ }
try {
    $env:PATH = "$(Join-Path $taskSdkRoot "bin/$taskSdkVersion/x64");$taskOldPath"
    $env:INCLUDE = @((Join-Path $taskVcRoot 'include')) + (@('ucrt', 'shared', 'um', 'winrt', 'cppwinrt') |
        ForEach-Object { Join-Path $taskSdkRoot "Include/$taskSdkVersion/$_" }) -join ';'
    $env:LIB = @((Join-Path $taskVcRoot 'lib/x64'), (Join-Path $taskSdkRoot "Lib/$taskSdkVersion/ucrt/x64"),
        (Join-Path $taskSdkRoot "Lib/$taskSdkVersion/um/x64")) -join ';'
    Push-Location -LiteralPath $taskOutput
    try {
        $taskArguments = @('/nologo', '/std:c++17', '/EHsc', '/O2', '/W4', '/utf-8', '/DUNICODE', '/D_UNICODE') + $taskSources +
            @('/Fe:window-audit.exe', '/link', '/MANIFEST:EMBED', "/MANIFESTINPUT:$(Join-Path $PSScriptRoot 'window-audit.manifest')",
                'user32.lib', 'gdi32.lib', 'd3d11.lib', 'dxgi.lib', 'dcomp.lib', 'dwmapi.lib', 'windowsapp.lib', 'ole32.lib')
        & (Join-Path $taskVcRoot 'bin/Hostx64/x64/cl.exe') @taskArguments
        if ($LASTEXITCODE -ne 0) { throw "Window Audit build failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
    $taskSourceHashes = Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in @('.cpp', '.hpp', '.ps1', '.manifest') } |
        ForEach-Object { [ordered]@{ name = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } }
    [ordered]@{
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        executable = (Join-Path $taskOutput 'window-audit.exe')
        executableSha256 = (Get-FileHash -LiteralPath (Join-Path $taskOutput 'window-audit.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
        compilerRoot = $taskVcRoot
        windowsSdk = $taskSdkVersion
        sources = @($taskSourceHashes)
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskOutput 'build-provenance.json') -Encoding UTF8
    Write-Output (Join-Path $taskOutput 'window-audit.exe')
} finally {
    $env:PATH = $taskOldPath
    $env:INCLUDE = $taskOldInclude
    $env:LIB = $taskOldLib
}
