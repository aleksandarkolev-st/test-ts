# Windows 0.2.2 package

`npm run package` built `src-tauri/target/release/bundle/msi/Meeting Copilot_0.2.2_x64_en-US.msi` (966.14 MiB). Administrative extraction into `.local/msi-upgrade-0.2.2` succeeded. The release bundle includes the pinned official Codex 0.160.1 executable and original LICENSE/NOTICE, full English Q8 Nemotron weights and isolated Vulkan binaries, the frozen Python/DirectML camera worker, both FLX eye models, the MediaPipe task and legacy Whisper assets.

`scripts/package-smoke.mjs --keep --use-bundled-speech --use-codex` verified version 0.2.2, 29 required files, matching release executable/DLL contents, all 950 sidecar resources against their build sources and pinned Codex/speech/landmark hashes. The extracted production app discovers real audio devices, confirms native capture-protection readback and rejects acceptance/debug instrumentation. Its frozen worker discovers Camo and RX 9070 XT, delivers a local preview and clears it on Stop. Python and TensorFlow are not required on a recipient's machine. OBS Virtual Camera's driver remains an external prerequisite.

The extracted app remains open and idle with the authenticated native Codex account, GPT-6 Luna, Fast speed and xhigh effort. These settings were restored and verified after the low-effort benchmark. Production UI reload assertions and actual project/screenshot/audio model checks pass; see [Codex evidence](codex-verification.md). Fresh settings retain the legacy backend for compatibility; choose Codex explicitly. No global MSI installation was performed. These checks establish extraction and portable production startup on this machine; they do not establish clean-machine prerequisites, MSI upgrade/uninstall behavior, calibrated camera naturalness or every screen-sharing consumer. Results: `artifacts/package/results.json`.

Final MSI SHA-256: `16120f72d6d06ffa06aa2d14e43d3080464b17ccb6d0c49e3ca454134feea95a`.

Prepare Codex with `scripts/setup-codex.ps1`, Nemotron with `scripts/setup-nemotron.ps1`, and camera resources with `scripts/setup-gaze.ps1` followed by `scripts/build-gaze.ps1`. The camera build keeps PyInstaller's cache in the workspace, collects original wheel/Python licenses and checks frozen device discovery. Then run `npm run package`.

The previous 0.2.1 package passed 25 required-file and 946-resource checks after the FLX corner-centered crop fix. Its report is retained as `artifacts/package/results-0.2.1.json`; current evidence above supersedes it.
