param(
    [ValidateSet('efforts','audio','all')][string]$Mode = 'efforts',
    [switch]$Resume
)
$ErrorActionPreference = 'Stop'
# Keep the system awake only for this benchmark. Explicit user sleep is honored.
Add-Type @'
using System.Runtime.InteropServices;
public static class BenchmarkPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
$previous = [BenchmarkPower]::SetThreadExecutionState([uint32]2147483651)
if ($previous -eq 0) { throw 'Cannot request temporary benchmark wakefulness' }
try {
    $env:COPILOT_BENCH_SLEEP_GUARD = 'system_and_display_required'
    $benchmarkModes = if ($Mode -eq 'all') { @('efforts','audio') } else { @($Mode) }
    foreach ($benchmarkMode in $benchmarkModes) {
        $env:COPILOT_BENCH_MODE = $benchmarkMode
        if ($Mode -eq 'all') { $env:COPILOT_BENCH_FILE = "realtime-$benchmarkMode-20.json" }
        $benchmarkArguments = @((Join-Path $PSScriptRoot 'realtime-latency-benchmark.mjs'))
        if ($Resume) { $benchmarkArguments += '--resume' }
        & node @benchmarkArguments
        $benchmarkExitCode = $LASTEXITCODE
        if ($benchmarkExitCode -ne 0) { break }
    }
} finally {
    [void][BenchmarkPower]::SetThreadExecutionState($previous)
    Remove-Item Env:COPILOT_BENCH_SLEEP_GUARD -ErrorAction SilentlyContinue
}
exit $benchmarkExitCode
