# Meeting Copilot

A local Windows 10/11 meeting assistant. It captures playback and microphone audio separately, transcribes English with Nemotron Speech Streaming EN 0.6B on the device, detects remote questions, and streams suggested spoken answers into a native overlay. Whisper remains an explicitly selectable legacy backend.

## Run

New Windows builds use **mscv32.exe** with the Task Manager display name **mscv32** and a gray cogwheel icon. The in-app name remains Meeting Copilot. The Windows installer upgrade ID and application settings identity stay the same. Rebuild and relaunch the app to use the new executable and icon.

Run `npm run desktop` from this project to launch the development app, or open the built `mscv32.exe`. While it is running, press **Ctrl + Shift + F9** from any application to hide the visible setup window or restore and focus it when hidden or minimized. Launching the executable again brings the existing setup window forward. The overlay's **Setup** button opens the same window.

The existing x64 installer is `src-tauri/target/release/bundle/msi/Meeting Copilot_0.2.2_x64_en-US.msi`. It bundles the official native Codex runtime, Nemotron Vulkan runtime and English Q8 weights, the standalone DirectML camera worker, FLX eye models and MediaPipe landmark model. The current source selects speech GPUs by name and resolves their current Vulkan indices at startup. The installer predates the latest realtime changes. OBS Virtual Camera's driver must already be installed for camera output.

1. Open **Answers** in Meeting Copilot, set **Answer backend** to **Codex**, then reconnect the native Codex account or complete sign-in. Choose **GPT-6 Luna** from the account's live catalog and **Fast** under **Answer speed**. Reasoning effort is a separate setting. The alternative ChatGPT-plan API backend retains its own browser sign-in flow.
2. Open **Meeting** and choose your microphone and the playback device used by your meeting. Use the installed Nemotron runtime and English GGUF model, select 80/160/560/1120 ms chunks, and choose a named speech GPU. Automatic selection prefers a discrete GPU. The default chunk is 160 ms.
3. Click **Start meeting**. Questions from the playback stream trigger answers automatically. **Stop meeting** releases capture and clears meeting content held in memory.
4. For eye contact, select your input camera under **Camera**, start preview, calibrate looking at the camera, then calibrate looking at notes below it. Select **OBS Virtual Camera** in your call. Start around 10–12°; the maximum is 15°. **Stop camera** closes video and clears calibration. See [camera verification and current input limitations](docs/camera-verification.md).

Headphones help avoid playback voices entering the microphone. Loopback captures all audio on the selected output, so other apps playing speech are also treated as REMOTE. This MVP does not identify individual speakers.

| Shortcut | Action |
| --- | --- |
| Ctrl + Shift + F9 | Show / hide the setup window (restore when minimized) |
| Ctrl + Shift + Space | Open manual question input |
| Ctrl + Shift + H | Hide/show overlay in native code |
| Ctrl + Shift + X | Dismiss answer |
| Ctrl + Shift + M | Pause/resume capture |
| Ctrl + Shift + E | Request a longer answer |
| Ctrl + Shift + P | Detect and send the active project or browser view to AI |
| Ctrl + Alt + Arrow keys | Move the focused setup window, or the overlay |
| Ctrl + Shift + Up / Down | Scroll the focused setup window, or the answer overlay vertically |
| Ctrl + Shift + Page Up / Page Down | Scroll the focused setup window, or the answer overlay |
| Ctrl + Shift + Home / End | Jump to the top / bottom of that reading surface |
| Ctrl + Shift + Left / Right | Scroll the visible code block horizontally |
| Ctrl + Shift + F8 | Capture the monitor under the pointer and send it to AI |

Setup uses four keyboard-accessible sections: **Meeting**, **Answers**, **Context**, and **Camera**. Meeting controls stay within reach while you read settings. Answers distinguish fenced and recognizable code from prose, retain exact source offsets, and provide a copy control. Focus a long question with Tab to page through its complete text; otherwise the reading shortcuts scroll the answer. The pixel companion uses Space UI navigation, a Componentry pointer trail, and a Canvas UI ripple, with motion disabled when requested.

Drag the overlay by its status header. Automatic answers do not request focus; manual input explicitly does. If another app owns a shortcut, startup reports the conflict and the corresponding on-screen control remains available.

New settings default to Codex, Fast and low reasoning effort. Existing Codex xhigh settings migrate to low for realtime use; other selected efforts remain available. **Model default** omits an explicit effort, whereas **None** explicitly disables reasoning. Account model availability comes from the live catalog. Codex **Fast** speed is independent of effort and uses the account's Fast allowance.

The current signed-in Codex path starts speculative inference on remote transcript candidates and lets the model classify reply intent in the same inference. Three prepared threads support at most two active answers. Growing questions and changed context are coalesced; output carries exact question/context identity and is shown only for the confirmed current frame. Superseded output is retracted, and obsolete-turn replacement requires terminal cleanup. Exact earlier code remains available for deeper follow-ups. See [adaptive interview verification](docs/adaptive-interview.md) and the [latency audit](docs/latency-audit.md).

Historical refill results remain in [the refill benchmark](docs/refill-benchmark.md); the earlier scheduler and its five-sample effort trials remain in [speculative answering](docs/speculative-answering.md). The current report distinguishes provisional first text from text retained for the final question and retains slow trials. These controlled fact-recall checks do not establish general meeting accuracy or a sub-second service guarantee.

The earlier 100-trial release run recalled its controlled fact in 100/100 answers. Audio median confirmed-answer visibility was 1945 ms at 80 ms chunks and 2709 ms at 160 ms, with a retained 54.9-second outlier. Forty audio questions used 51 jobs with 11 cancellations. See [the full results, limits and raw evidence](docs/realtime-optimization.md#final-100-sample-release-results).

### Reducing first-answer delay

Meeting startup prepares three ephemeral threads for the selected model, speed and effort. Confirmation requires a final transcript and 200 ms of silence. Retrieval budgets relevant memory and conversation separately from exact suggested code and explicit attachments. Partial question refinements wait for stability and a minimum cadence; changed selected context has a bounded submission deadline. Final confirmation supplies the latest question and context. Timing records the first retained answer-word character separately from completion and rendering. Stop clears all work and closes the persistent authenticated broker. The sub-800 ms target remains unmet in current live evidence.

## Privacy and capture protection

During a meeting, **Ctrl + Shift + F8** (or **Send screenshot**) captures the complete monitor under the mouse pointer as a lossless PNG and asks the AI to explain the visible task. The overlay hides during capture and returns without taking focus. The latest screenshot remains in RAM for follow-up answers until **Remove screenshot** or **Stop meeting**. Retaking replaces it. Screenshots are sent inline to OpenAI; there is no file upload or screenshot library. Image understanding requires a model that accepts image inputs; service errors are shown normally. [ChatGPT plan input support](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

During a meeting, **Ctrl + Shift + P** (or **Send active context**) detects the active VS Code workspace or Explorer folder and sends its complete readable text to OpenAI for a streamed overview. A browser view or an unresolved editor uses a screenshot of that window's monitor. Detection is local; transmission requires this explicit action. To override detection, choose a **Project folder** before starting and use **Send selected project**. Attached source remains in RAM for follow-up answers until **Remove project** or **Stop meeting**. No project content is saved to SQLite. Only an explicitly selected folder path is saved with settings.

Project collection respects `.gitignore`, `.ignore`, and Git exclusions; generated folders, repository metadata, and common credential files are excluded. Binary/non-UTF-8 files and symbolic links appear in the skipped-file list. Limits are 2 MiB per file, 4 MiB total text, and 4000 scanned files. Exceeding a limit fails the attachment instead of silently truncating it. These local limits do not guarantee the selected answer model can accept the project's full context; a model/service context-limit error is shown normally.

Save editor changes, then use **Refresh project** beside the attachment to re-read the same folder, even if another window is now active. **Included files** lists the shared paths and total text size; the read time helps identify an older snapshot. Unsaved editor buffers are not included.

**Interview task** is available in the overlay and the setup window's **Context** section during a meeting. Save a **Problem statement**, or use **Use current question** to keep the current question as the problem. Paste new results into **Test output** and choose **Update test output** after running your code. The saved problem stays attached across follow-ups, project refreshes and screenshot retakes. Source labels show when the screenshot, saved project files and test output were last updated. Task context stays in RAM.

**New task** clears the problem, test output, project, screenshot, question, answer and prior task conversation without stopping audio capture or changing pause state. Pending context results from the previous task are discarded. Use it when the interviewer moves to a different problem; **Dismiss** only dismisses the answer and retains the task.

Sharing or refreshing context re-answers the current interview question using the latest attachments. Without a current question, it uses the saved problem; without a saved problem, a project starts an architecture overview and a screenshot starts help with the visible task. **Retake screenshot** replaces the previous image and updates its capture time.

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

`Ctrl Shift P` detects the current VS Code workspace or Explorer folder and attaches it on demand. Browser IDEs and editors whose local folder cannot be resolved use a screenshot of that window's monitor. Detection does not transmit context until the shortcut or **Send active context** control is used. A manually selected folder remains available through **Send project**. VS Code detection currently supports existing single-folder workspace-storage records; ambiguous matches require explicit folder selection.

`Ctrl Alt Left/Right/Up/Down` moves the focused setup window, or the overlay when another app has focus, in 40 logical-pixel steps. Positions are clamped to the current monitor's work area.

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

The [adaptive GPU interview evaluation](docs/adaptive-interview.md) runs 24 scenarios with progressively deeper follow-ups through signed-in Codex, using Luna by default. It records exact questions, answers, timing, reviews, and resumable checkpoints; the near-instant latency target remains unmet in the live evidence collected so far.

The [learned local intent-gate experiment](docs/intent-gate-experiment.md) measures CPU classification and early-versus-final sending without canned answers or phrase routing. It remains disabled in release builds: the corrected audio comparison showed insufficient readiness coverage and no demonstrated latency improvement.

For ten minutes of controlled negative speech playback through WASAPI, set `COPILOT_NEGATIVE_MINUTES=10`. The harness checks false answer requests and context-compression cadence. Synthetic corpus fixtures can be generated with `scripts/create-corpus.ps1` and checked with the ignored `speech_corpus` integration test.

Live account latency checks use `scripts/live-service-check.mjs` against an already signed-in production app exposed on a local WebView2 CDP port. They save numeric measurements only. Manual request latency and speech-end-to-visible-answer latency are reported separately. The helper brackets both question confirmation and DOM appearance across polling round trips; four offline tests cover these bounds. `scripts/combine-live-service-results.mjs` selects the latest approved Luna/xhigh real-audio run and retains earlier trials and diagnostics.

For the controlled context-recall check, generate `.local/audio/context-statement.wav` with `create-audio-fixture.ps1` using the synthetic sentence "The team has agreed that our launch target for next quarter is February nineteenth." Set `COPILOT_LIVE_CONTEXT_CHECK=1` with real-audio mode. The helper plays the statement before the question and records only whether each answer recalls the date. These seeded samples are labeled separately from earlier question-only trials.

## License

MIT. Third-party source retains its original licenses. whisper.cpp and GGML are MIT; whisper-rs-sys is Unlicense. The bundled Whisper model originates from [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), based on OpenAI Whisper.
