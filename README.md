# Meeting Copilot

A local Windows 10/11 meeting assistant. It captures playback and microphone audio separately, transcribes English with Nemotron Speech Streaming EN 0.6B on the device, detects remote questions, and streams suggested spoken answers into a native overlay. Whisper remains an explicitly selectable legacy backend.

## Run

The existing x64 installer is `src-tauri/target/release/bundle/msi/Meeting Copilot_0.2.2_x64_en-US.msi`. It bundles the official native Codex runtime, Nemotron Vulkan runtime and English Q8 weights, the standalone DirectML camera worker, FLX eye models and MediaPipe landmark model. Select the appropriate GPU on your machine; on this computer the RX 9070 XT is index 1. OBS Virtual Camera's driver must already be installed for camera output.

1. Open Meeting Copilot, set **Answer backend** to **Codex**, then reconnect the native Codex account or complete sign-in. Choose **GPT-6 Luna** from the account's live catalog and **Fast** under **Answer speed**. Reasoning effort is a separate setting. The alternative ChatGPT-plan API backend retains its own browser sign-in flow.
2. Choose your microphone and the playback device used by your meeting. Use the installed Nemotron runtime and English GGUF model, select 80/160/560/1120 ms chunks, and choose the Vulkan GPU index (1 is the RX 9070 XT on this computer). The default chunk is 160 ms.
3. Click **Start meeting**. Questions from the playback stream trigger answers automatically. **Stop meeting** releases capture and clears meeting content held in memory.
4. For eye contact, select your input camera under **Eye contact**, start preview, calibrate looking at the camera, then calibrate looking at notes below it. Select **OBS Virtual Camera** in your call. Start around 10–12°; the maximum is 15°. **Stop camera** closes video and clears calibration. See [camera verification and current input limitations](docs/camera-verification.md).

Headphones help avoid playback voices entering the microphone. Loopback captures all audio on the selected output, so other apps playing speech are also treated as REMOTE. This MVP does not identify individual speakers.

| Shortcut | Action |
| --- | --- |
| Ctrl + Shift + Space | Open manual question input |
| Ctrl + Shift + H | Hide/show overlay in native code |
| Ctrl + Shift + X | Dismiss answer |
| Ctrl + Shift + M | Pause/resume capture |
| Ctrl + Shift + Up | Request a longer answer |
| Ctrl + Shift + P | Send the selected project to AI |
| Ctrl + Shift + F8 | Capture the monitor under the pointer and send it to AI |

Drag the overlay by its status header. Automatic answers do not request focus; manual input explicitly does. If another app owns a shortcut, startup reports the conflict and the corresponding on-screen control remains available.

The optional **Reasoning effort** selector uses the model default unless you choose a level. Answer requests then send the chosen effort explicitly. [GPT-6 Luna supports low and xhigh](https://developers.openai.com/api/docs/models/gpt-6-luna). Account model availability comes from the live catalog. Codex **Fast** speed is independent of effort and uses the account's Fast allowance.

The current source starts answers speculatively on local question candidates, using three prepared Codex threads and refilling after the first agent text delta, with terminal-notification fallback for cancelled or empty turns. It buffers text until confirmation, runs at most two answers, holds one pending burst, and merges explicit follow-ups. See [scheduler behavior and verification](docs/speculative-answering.md).

The embedded release's 20-sample send-to-first-delta medians were **2.091 s for immediate refill**, **1.940 s for deferred refill**, and **1.895 s with refill disabled**. Paired comparisons do not establish a refill latency benefit. In 20 audio samples per chunk size, 80 ms delivered the first partial a median **81 ms earlier**, but transcript revisions repeatedly restarted generation and erased most speculative head start. Speech-end-to-native-visibility medians were **2.100 s at 80 ms** and **2.258 s at 160 ms**; neither meets a hard sub-second target. See [all measurements, bounds and interrupted harness checks](docs/refill-benchmark.md).

Final five-sample Codex/GPT-6 Luna/Fast medians from speech end to visible text were **3.234 s at low** and **2.001 s at xhigh**, with seeded context recall **5/5 each**. Preliminary measurements were 1.812 s and 2.4165 s and included a 9.9815 s low outlier. The reversed ordering shows substantial service variability; these samples do not establish a reliable effort speed advantage. The two-second target remains unmet in the final runs. Both complete runs are retained.

The updated loose release executable `.local/msi-upgrade-0.2.2/PFiles/Meeting Copilot/meeting-copilot-speculative-final.exe` is running with Codex/Fast/xhigh restored. The previously listed MSI contains the earlier pipeline and has not been rebuilt for this change.

### Reducing first-answer delay

Meeting startup prepares two ephemeral threads for the selected model, speed and effort. Candidate inference overlaps the existing 500 ms confirmation window. Consuming a prepared thread triggers background replenishment; confirmed questions release their buffered tokens. Stop clears all work and closes the broker. The final runs started generation 279-677 ms before confirmation. Lower effort alone did not produce a consistent latency advantage.

## Privacy and capture protection

During a meeting, **Ctrl + Shift + F8** (or **Send screenshot**) captures the complete monitor under the mouse pointer as a lossless PNG and asks the AI to explain the visible task. The overlay hides during capture and returns without taking focus. The latest screenshot remains in RAM for follow-up answers until **Remove screenshot** or **Stop meeting**. Retaking replaces it. Screenshots are sent inline to OpenAI; there is no file upload or screenshot library. Image understanding requires a model that accepts image inputs; service errors are shown normally. [ChatGPT plan input support](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Choose a **Project folder** before starting the meeting. During a meeting, **Ctrl + Shift + P** (or **Send project**) reads it again and sends its complete readable text to OpenAI for a streamed overview. The source remains in RAM for automatic and manual follow-up answers until **Remove project** or **Stop meeting**. No project content is saved to SQLite. The folder path is saved with settings.

Project collection respects `.gitignore`, `.ignore`, and Git exclusions; generated folders, repository metadata, and common credential files are excluded. Binary/non-UTF-8 files and symbolic links appear in the skipped-file list. Limits are 2 MiB per file, 4 MiB total text, and 4000 scanned files. Exceeding a limit fails the attachment instead of silently truncating it. These local limits do not guarantee the selected answer model can accept the project's full context; a model/service context-limit error is shown normally.

- Raw audio is processed locally. No audio upload, recording library, or transcript database is implemented.
- Recent transcript and compact meeting memory are sent to OpenAI when answering questions or compressing context. Codex uses ephemeral threads with history persistence disabled; the ChatGPT-plan API uses `store:false` and `stream:true`. These settings do not override the service's data policies.
- SQLite stores settings, host registration ID, selected account ID, and meeting start/end metadata. The native Codex runtime manages its own account credentials. ChatGPT-plan API tokens and account metadata are stored in Windows Credential Manager.
- Stop clears transcript, memory, question, answer, and latency state. Debug transcript display exists only in development builds and clears on Stop. Application logs contain numeric latency measurements, not meeting text.
- **Share protection active** means `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` succeeded and `GetWindowDisplayAffinity` confirmed it. It is not a security guarantee for every capture app. Consult [verification status](docs/verification.md) before relying on a capture path.

ChatGPT plan authorization follows OpenAI's current [open-source client flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). Eligibility and availability are controlled by OpenAI. This client uses dynamic registration, OAuth PKCE, a loopback callback, signed identity-token validation, refresh-token rotation, and a stable local host ID. Closed-source commercial distribution requires the applicable OpenAI participation terms.

## Build from source

Prepare the pinned official English Q8 model and Windows Vulkan runtime with `./scripts/setup-nemotron.ps1`; assets stay inside this workspace. `-RuntimeOnly` skips the approximately 700 MB weights. Nemotron is the default speech backend. It runs in a private authenticated loopback process with two independent cache-aware WebSockets, sends continuous PCM chunks, and releases both streaming states on pause/stop. Model loading can be cancelled. Neural batching is disabled: the pinned Vulkan runtime stalled concurrent realtime requests with batching enabled on this machine. `node scripts/nemotron-smoke.mjs` verifies actual synthetic streaming; set `COPILOT_NEMOTRON_CHUNK_MS` for each chunk and `COPILOT_NEMOTRON_BACKEND` for the required Vulkan adapter. See [remaining upgrade work](docs/upgrade-plan.md).

Prerequisites: Windows x64, Node.js 22 or newer, Rust, Visual Studio C++ Build Tools, CMake, Python, and Edge WebView2. WiX is fetched by the Tauri bundler when needed.

```powershell
.\scripts\setup.ps1
.\scripts\setup-nemotron.ps1
.\scripts\setup-codex.ps1
.\scripts\setup-gaze.ps1
npm run desktop
```

`setup.ps1` installs JavaScript dependencies, fetches Rust dependencies, prepares libclang for Windows FFI bindings, and downloads the tiny English Whisper model with a SHA-256 check. Model weights and build outputs are ignored by Git.

```powershell
.\scripts\build-gaze.ps1
npm run package
```

The native build includes baseline, SSE4.2, AVX, AVX2, and AVX512 CPU backends. GGML selects a supported backend at runtime. Build-machine CPU features are not baked into the installer. See [vendor changes](vendor/whisper-rs-sys/PATCHES.md).

## Tests

```powershell
npm test
npm run test:e2e
node --test tests/live-timing.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
.\scripts\create-audio-fixture.ps1
cargo test --manifest-path src-tauri/Cargo.toml --test local_transcription -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib credential_manager_survives -- --ignored
cargo build --manifest-path src-tauri/Cargo.toml --features acceptance
$env:COPILOT_REAL_AUDIO='1'
node scripts/native-e2e.mjs
```

The credential test creates and removes synthetic credentials under a random test key; it does not touch saved accounts. Native acceptance uses real WASAPI, VAD, the selected local speech backend, Win32 windows, and a local HTTP Responses fixture. Test authentication and event injection require both the `acceptance` feature and a debug build; release builds reject them.

For the wall-clock stability check, set `COPILOT_SOAK_MINUTES=60` and a free `COPILOT_CDP_PORT` before running `scripts/native-e2e.mjs`. The harness uses an isolated executable copy and reports numeric metrics under `artifacts/soak`. Capture tests use an isolated portable OBS installation, a synthetic screen background, and visible positive controls.

The complete acceptance ledger is in [docs/verification.md](docs/verification.md). Automated fixture checks alone do not establish real meeting accuracy, live-service latency, or compatibility with all screen-sharing products.

For ten minutes of controlled negative speech playback through WASAPI, set `COPILOT_NEGATIVE_MINUTES=10`. The harness checks false answer requests and context-compression cadence. Synthetic corpus fixtures can be generated with `scripts/create-corpus.ps1` and checked with the ignored `speech_corpus` integration test.

Live account latency checks use `scripts/live-service-check.mjs` against an already signed-in production app exposed on a local WebView2 CDP port. They save numeric measurements only. Manual request latency and speech-end-to-visible-answer latency are reported separately. The helper brackets both question confirmation and DOM appearance across polling round trips; four offline tests cover these bounds. `scripts/combine-live-service-results.mjs` selects the latest approved Luna/xhigh real-audio run and retains earlier trials and diagnostics.

For the controlled context-recall check, generate `.local/audio/context-statement.wav` with `create-audio-fixture.ps1` using the synthetic sentence "The team has agreed that our launch target for next quarter is February nineteenth." Set `COPILOT_LIVE_CONTEXT_CHECK=1` with real-audio mode. The helper plays the statement before the question and records only whether each answer recalls the date. These seeded samples are labeled separately from earlier question-only trials.

## License

MIT. Third-party source retains its original licenses. whisper.cpp and GGML are MIT; whisper-rs-sys is Unlicense. The bundled Whisper model originates from [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), based on OpenAI Whisper.
