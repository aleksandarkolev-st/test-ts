# Window Audit

Standalone Windows x64 diagnostic for raw HWND discovery and controlled capture
experiments. It does not change the Meeting Copilot application. Normal audits
read metadata and capture no pixels. No installation, injection, hooks, or driver
changes are involved.

Build with Visual Studio C++ build tools and a recent Windows 11 SDK:

```powershell
./tools/window-audit/build.ps1
```

The executable and source/executable hashes are written to
`artifacts/window-audit/bin/`. Run from the repository root:

```powershell
# All discoverable windows, including hidden and untitled windows.
./artifacts/window-audit/bin/window-audit.exe --all --output artifacts/window-audit/windows.json

# A process's windows, with foreign ancestors and owners retained as context.
./artifacts/window-audit/bin/window-audit.exe --pid 1234 --output artifacts/window-audit/process.json

# Run while showing/hiding the target overlay to record property changes.
./artifacts/window-audit/bin/window-audit.exe --pid 1234 --watch 60 --output artifacts/window-audit/watch.json

# Separate observer/renderer processes; temporarily displays owned test windows.
./artifacts/window-audit/bin/window-audit.exe --self-test --output artifacts/window-audit/test-1

# Faster HWND-only fixture validation, without GPU capture experiments.
./artifacts/window-audit/bin/window-audit.exe --enumeration-test --output artifacts/window-audit/enumeration-1

# Independently decode the saved BMPs and verify the reported classifications.
node tools/window-audit/verify-report.mjs artifacts/window-audit/test-1
```

Use a fresh directory for each self-test. The report is `report.json`; individual
window snapshots, capture measurements, and 256 x 144 BMP regions are saved beside
it. The verifier also writes `verification.json` with image hashes and a readable
`summary.html`, and checks that changing a clean reference pixel to black is
rejected. A self-test exit code of 0 means the diagnostic's required controls passed.
It does **not** mean an overlay passed the invisibility requirement. Code 2 means
a required fixture/control failed or was inconclusive; code 1 is a fatal error.
The fixture process runs in a kill-on-close job and exits if its observer exits.

## Discovery coverage

- Raw `EnumWindows`, without title, visibility, or tool-window filtering.
- `EnumDesktopWindows` on desktops that can be opened in the current window
  station; denied desktops are recorded. `--current-desktop-only` skips that pass.
- `EnumChildWindows`, which already includes descendants, plus an independent
  breadth-first `FindWindowEx` direct-child walk.
- `EnumThreadWindows` for the system thread snapshot. A thread with no nonchild
  windows is normal and is not recorded as an enumeration failure.
- Explicit `FindWindowEx(HWND_MESSAGE, ...)` discovery of message-only windows.
- Parent, owner, root and root-owner relationships, PID/TID, executable path,
  title/class, styles, visibility, bounds, cloaking, layered opacity, and capture
  affinity queries. Query failures and access limits remain visible in reports.
- Process snapshot entries are separate from window discovery. `--pid` can
  report a running process with zero observed windows.

Hidden, tool, topmost, no-activation, zero-opacity, cloaked, cross-process-parent,
and capture-affinity findings describe observable properties. They are not
malware classifications. Ownership and parenting are reported separately.
Filtering happens **after** traversal, so a target's child under another process's
root can still be discovered. Watch mode records additions, removals, and changes
to the reported properties. Its interval is a minimum delay between completed
snapshots; windows that exist only between polls can be missed.

## Capture experiment

The fixture supplies three nonblack checkerboard backgrounds and a magenta
overlay. A continuously changing footer encourages fresh desktop frames. The
observer samples the full 256 x 144 overlay rectangle using GDI, PrintWindow, Desktop
Duplication, Windows Graphics Capture of a window, and WGC of the monitor.

Cases include an ordinary tool popup, `WDA_MONITOR`,
`WDA_EXCLUDEFROMCAPTURE`, a normal child, an affinity request on a child,
exclusion followed by reparenting, an unprotected presentation-surface control,
protected readback, and the protected alpha-effect experiment. Affinity setter
results and getter results are both retained; a failed setter is not treated as
protection. All parenting is between windows created by this test.

Each capture records RGB match fractions and is classified as `live_background`,
`overlay_visible`, `black_mask`, `stale_or_wrong_background_phase`,
`unpainted_capture_buffer`, or `mixed_or_unexpected`. API failures/timeouts are
`capture_unavailable` and cannot count as clean omission. Results cover the
sampled region, not every pixel on every display. A clean result requires
**every sampled pixel** to match its expected background color within six levels
per RGB channel; even one black pixel in this nonblack reference region prevents
a clean classification.

Monitor capture controls must separately recognize the current background,
ordinary overlay, `WDA_MONITOR` black mask, and excluded-popup background in all
three phases. Window captures have different semantics: for popup cases they
target the popup, while child/surface cases target the scene host. A capture of
an excluded window may be unavailable or black. That is recorded separately and
does not show that monitor capture contains a black box.

## Actual application workflow

`--self-test` renders synthetic overlays. The commands below instead inspect
the running application's own overlay and its descendant processes, including
WebView2. Identify the live root PID and the actual overlay HWND from a raw
audit; the setup window has a different HWND and is outside this capture target.
Keep setup hidden during observed overlay states. Launch and show/hide the app
through its normal UI and shortcuts; these diagnostics do not control its UI.

```powershell
# Replace 1234 with the running application's root process ID.
./tools/window-audit/audit-process-tree.ps1 -RootProcessId 1234 `
  -OutputDirectory artifacts/window-audit/real-app-new/state-hidden
```

This saves the unfiltered native snapshot and `application-windows.json`, which
retains descendant-process HWNDs and foreign parent/owner context. Repeat into
fresh state directories while the real overlay is shown, hidden and reopened.
Record the executable SHA256 and build-input provenance for the binary tested.

For ordinary desktop content, capture the real overlay rectangle without
creating a reference window or changing the desktop:

```powershell
./artifacts/window-audit/bin/window-audit.exe --capture-real --hwnd 0x123456 `
  --desktop-content --output artifacts/window-audit/real-app-desktop/captures `
  --prefix hidden-before
```

Use fresh prefixes for hidden-before, shown and hidden-after captures, with
matching process-tree audits of each state. This mode omits `--phase` and
`--origin`. It saves full-frame pixels, RGB hashes and exact/near-black counts;
its native classification is `uncalibrated_desktop_content`. Natural black
pixels are not themselves evidence of a mask. A stable matched hidden-before
and hidden-after reference is required before comparing the shown overlay;
changed desktop content or unavailable APIs leave that comparison inconclusive.

Verify an ordinary-desktop run with:

```powershell
node tools/window-audit/verify-desktop-content.mjs artifacts/window-audit/real-app-desktop
```

Its `manifest.json` requires `schemaVersion: 1`, `rootProcessId`, distinct
`overlayHwnd`/`setupHwnd`, `expectedExecutablePath`, `applicationProvenanceFile`,
`windowStates` and `sets`. Window-state entries contain `label`, `reportFile`
and a role of `hidden_before`, `shown_overlay` or `hidden_after`. Each set links
the three native capture reports to their window-state labels:

```json
{
  "label": "Ordinary desktop",
  "hiddenBefore": { "reportFile": "captures/before-report.json", "windowStateLabel": "Hidden before" },
  "shown": { "reportFile": "captures/shown-report.json", "windowStateLabel": "Shown" },
  "hiddenAfter": { "reportFile": "captures/after-report.json", "windowStateLabel": "Hidden after" }
}
```

All evidence paths are relative to the run directory. The verifier independently
decodes full-frame BMPs, verifies native RGB measurements and linked application
states, and writes `verification.json` and `summary.html`. Both hidden controls
must match exactly for that method before it can judge the shown capture.
Existing black desktop pixels are allowed; newly black pixels are compared with
the actual baseline. A changing desktop yields an inconclusive comparison.

The controlled-background variant creates only an owned measurement background
under the real overlay. It does not replace or modify the application's renderer.
Run the reference command in a separate terminal; its output directory must be
new/empty, and its control file should be outside that directory:

```powershell
# Replace this illustrative HWND with the current actual overlay HWND.
./artifacts/window-audit/bin/window-audit.exe --reference-backdrop `
  --hwnd 0x123456 --control artifacts/window-audit/real-app-new/control.txt `
  --output artifacts/window-audit/real-app-new/reference --seconds 600
```

The control file accepts `0`, `1`, `2` or `stop`. Atomic `status.json` records
the phase, DWM frame bounds, reference origin and z-order acknowledgement. The
reference follows target geometry and exits when its target disappears or its
PID/TID changes. Its animated strip is outside the measured overlay rectangle.

With the actual overlay hidden, capture three reference phases; then show the
actual overlay with its normal shortcut and repeat using a fresh prefix and
`-ExpectedVisibility shown`:

```powershell
./tools/window-audit/capture-real-phases.ps1 -TargetHwnd 0x123456 `
  -ReferenceDirectory artifacts/window-audit/real-app-new/reference `
  -ControlFile artifacts/window-audit/real-app-new/control.txt `
  -OutputDirectory artifacts/window-audit/real-app-new/captures `
  -Prefix hidden -ExpectedVisibility hidden

# A single phase can also be captured directly, using the acknowledged origin.
$taskReference = Get-Content artifacts/window-audit/real-app-new/reference/status.json -Raw | ConvertFrom-Json
./artifacts/window-audit/bin/window-audit.exe --capture-real --hwnd 0x123456 `
  --phase $taskReference.phase --origin "$($taskReference.origin.x),$($taskReference.origin.y)" `
  --output artifacts/window-audit/real-app-new/captures --prefix single-phase
```

External capture covers every pixel of the actual overlay's DWM frame through
GDI, Desktop Duplication, WGC monitor and direct WGC window capture. It never
calls external `PrintWindow`. Before/after HWND identity, geometry, visibility
and affinity accompany every sample. Errors or target changes cannot count as
clean omission. A native exit code of 0 means at least one method returned pixels;
inspect each method's result.

Create `manifest.json` linking the root PID, distinct overlay/setup HWNDs,
expected executable path, application provenance, labelled window-state reports
and each capture/reference-status pair. Capture entries require a role
(`hidden_control`, `shown_overlay`, `reopened_overlay` or `moved_overlay`) and an
explicit `windowStateLabel` matching the linked process-tree report. Use the
recorded [run manifest](../../artifacts/window-audit/real-application-20261016/manifest.json)
as the schema example. Without a manifest, verification remains exploratory.

```powershell
node tools/window-audit/verify-real-app.mjs artifacts/window-audit/real-app-new
```

The independent verifier decodes BMPs, checks provenance and linked window
states, and writes `verification.json` and `summary.html`. A monitor pass requires
the full current checkerboard, zero black pixels, stable target state, and an
**identical saved BMP SHA256** to its hidden-overlay control for the same method,
phase and frame. Direct WGC window failures remain unavailable; they are never
treated as clean captures.

The [2026-10-16 controlled actual-app run](../../artifacts/window-audit/real-application-20261016/summary.html)
observed 12 application processes and 43 HWNDs. Its actual overlay remained
enumerable. All 21 shown/reopened monitor images exactly matched their hidden
controls with no black pixels; 13 direct WGC window attempts were unavailable.
These measurements used a known reference background, not ordinary desktop
content. Physical panel visibility remains unverified.

## Limits

The [File Explorer follow-up](../../artifacts/window-audit/file-explorer-20261016/summary.html)
repeats the ordinary-content protocol with the actual Ctrl+Shift+H overlay over
the real workspace folder in Explorer. All three monitor methods match both
hidden endpoints exactly (9 BMPs, no changed or added-black pixels); raw
enumeration still finds the shown overlay. Setup stayed hidden. This run is
separate from the Calculator and controlled-reference cohorts below.

The [2026-10-16 ordinary desktop run](../../artifacts/window-audit/ordinary-desktop-20261016/summary.html)
uses the actual Ctrl+Shift+H overlay over normal Calculator UI and an existing
notification, with setup hidden and no reference renderer. All three monitor
methods exactly matched hidden-before, shown and hidden-after images: nine
verified BMPs, zero changed or newly black pixels, and three unavailable direct
WGC-window attempts. The separate detector still found the overlay and its
children; visible/titled top-level application windows changed 0 → 1 → 0. This
is one stationary desktop comparison, not a wallpaper-only or arbitrary-motion
test. The report includes saved-image previews and raw discovery evidence.

A snapshot is not atomic. Permission boundaries, other sessions/window stations,
secure desktops, protected processes and short-lived windows limit coverage.
Enumeration is bounded to 100,000 handles; truncation is explicit. The tool does
not inspect kernel objects, GPU allocations, drivers, firmware, hypervisors or
all compositor state. An HWND-free process can still be observable by other
means. Neither a passing diagnostic nor a clean capture proves invisibility to
all local software.

Capture omission cannot establish physical panel visibility. The protected
alpha-effect case therefore always leaves physical visibility unverified. Tests
also do not establish production overlay movement, interaction, recovery or
multi-monitor behavior. Display/session changes can invalidate capture resources
and are reported as capture errors. PrintWindow is used only against the owned
responsive fixture; it is synchronous and is not offered against arbitrary
external HWNDs.

Reports can contain window titles and executable paths. They are stored locally
and are not uploaded.

## API contracts

- [EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)
- [EnumChildWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumchildwindows)
- [EnumThreadWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumthreadwindows)
- [FindWindowEx](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-findwindowexw)
- [Window display affinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)
- [Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)
- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)
