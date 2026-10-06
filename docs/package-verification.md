# Windows 0.2.1 package

`npm run package` built `src-tauri/target/release/bundle/msi/Meeting Copilot_0.2.1_x64_en-US.msi` (862.08 MiB). Administrative extraction into `.local/msi-upgrade-0.2.1` succeeded. The release bundle includes the full English Q8 Nemotron weights and isolated Vulkan binaries, the frozen Python/DirectML camera worker, both exported FLX eye models, the MediaPipe task, legacy Whisper assets and original third-party notices.

`scripts/package-smoke.mjs --keep` verified the exact 0.2.1 application version, 25 required files, matching release executable/DLL contents, all 946 sidecar resources against their build sources, and pinned speech/landmark model hashes. The extracted production app defaults to Nemotron, discovers actual audio devices, reports native capture-protection readback and rejects acceptance/debug instrumentation. Its frozen worker discovers Camo and RX 9070 XT, delivers a real local preview and clears it on Stop. Python and TensorFlow are not required on a recipient's machine. OBS Virtual Camera's driver is an external prerequisite.

The extracted app remains open and idle with the saved Windows Credential Manager account, GPT-5.6 Luna and the approved xhigh effort. No global MSI installation was performed. These checks establish extraction and portable production startup on this machine; they do not establish clean-machine prerequisites, MSI upgrade/uninstall behavior, calibrated camera naturalness, or every screen-sharing consumer. Results: `artifacts/package/results.json`.

Final MSI SHA-256: `65283eeab6e4e380f5845f04b73d8f232ab972488ef80669bd36b42eb0235cb4`. The final extracted app and all resource checks were repeated after rebuilding the frozen camera worker with the original FLX corner-centered crop geometry.

Rebuild camera resources with `scripts/build-gaze.ps1` after `scripts/setup-gaze.ps1`. The build script keeps PyInstaller's cache in the workspace, collects original wheel/Python licenses and checks frozen device discovery. Then run `npm run package`. Nemotron runtime/model preparation is `scripts/setup-nemotron.ps1`.
