# Windows 0.2.0 package

`npm run package` built `src-tauri/target/release/bundle/msi/Meeting Copilot_0.2.0_x64_en-US.msi` (862.10 MiB). Administrative extraction into `.local/msi-upgrade-release` succeeded. The release bundle includes the full English Q8 Nemotron weights and isolated Vulkan binaries, the frozen Python/DirectML camera worker, both exported FLX eye models, the MediaPipe task, legacy Whisper assets and original third-party notices.

`scripts/package-smoke.mjs --keep` verified 25 required files, matching release executable/DLL contents, all 946 sidecar resources against their build sources, and pinned speech/landmark model hashes. The extracted production app defaults to Nemotron, discovers actual audio devices, reports native capture-protection readback and rejects acceptance/debug instrumentation. Its frozen worker discovers Camo and RX 9070 XT, delivers a real local preview and clears it on Stop. Python and TensorFlow are not required on a recipient's machine. OBS Virtual Camera's driver is an external prerequisite.

The updated extracted app remains open with the saved Windows Credential Manager account. No global MSI installation was performed. These checks establish extraction and portable production startup on this machine; they do not establish clean-machine prerequisites, MSI upgrade/uninstall behavior, calibrated camera naturalness, or every screen-sharing consumer. Results: `artifacts/package/results.json`.

Final MSI SHA-256: `92e6a15b80607ea6ae621a853b106f45335358a2d5d0fbdc381a568c03cdadc8`. The final extracted app and all resource checks were repeated after the punctuation-free question fix.

Rebuild camera resources with `scripts/build-gaze.ps1` after `scripts/setup-gaze.ps1`. The build script keeps PyInstaller's cache in the workspace, collects original wheel/Python licenses and checks frozen device discovery. Then run `npm run package`. Nemotron runtime/model preparation is `scripts/setup-nemotron.ps1`.
