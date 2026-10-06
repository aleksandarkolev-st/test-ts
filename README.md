# Meeting Copilot

A local Windows 10/11 meeting assistant. It captures playback and microphone audio separately, transcribes speech with whisper.cpp on the device, detects remote questions, and streams suggested spoken answers into a native overlay.

## Run

The x64 installer is built at `src-tauri/target/release/bundle/msi/Meeting Copilot_0.1.0_x64_en-US.msi`.

1. Open Meeting Copilot and choose **Continue with ChatGPT**. Complete the browser sign-in and grant plan usage. Available answer models are loaded from the account's catalog.
2. Choose your microphone and the playback device used by your meeting. The English speech model is bundled; a compatible local whisper.cpp model can also be selected.
3. Click **Start meeting**. Questions from the playback stream trigger answers automatically. **Stop meeting** releases capture and clears meeting content held in memory.

Headphones help avoid playback voices entering the microphone. Loopback captures all audio on the selected output, so other apps playing speech are also treated as REMOTE. This MVP does not identify individual speakers.

| Shortcut | Action |
| --- | --- |
| Ctrl + Shift + Space | Open manual question input |
| Ctrl + Shift + H | Hide/show overlay in native code |
| Ctrl + Shift + X | Dismiss answer |
| Ctrl + Shift + M | Pause/resume capture |
| Ctrl + Shift + Up | Request a longer answer |

Drag the overlay by its status header. Automatic answers do not request focus; manual input explicitly does. If another app owns a shortcut, startup reports the conflict and the corresponding on-screen control remains available.

The optional **Reasoning effort** selector uses the model default unless you choose a level. Answer requests then send `reasoning.effort` explicitly. For example, [GPT-5.6 Luna supports xhigh](https://developers.openai.com/api/docs/models/gpt-5.6-luna). Account model availability still comes from the live catalog; higher effort can increase first-answer latency.

The final signed-in production check measured the approved GPT-5.6 Luna/xhigh at **5.79 seconds median from speech ending to the first visible answer** across three real-audio samples, using the corrected timing bounds. All three answers recalled a synthetic fact captured before the question. Median request-to-first-token time was **4.90 seconds**; local finalization was **852 ms**. The plan's two-second target remains unmet. GPT-6 Luna was unavailable in the account catalog. See the [verification ledger](docs/verification.md) for measurements, comparisons and checks that remain unverified.

### Reducing first-answer delay

Stop the meeting, keep your selected model, change **Reasoning effort** from **xhigh** to **low**, then start the meeting again. Choose **none** to prioritize speed further. Lower effort can reduce reasoning quality; measure the result with the same audio and meeting context before treating it as an improvement. A setting change does not guarantee the two-second target.

The current xhigh benchmark spends most of its time waiting for the first model token. The app already streams text as it arrives and requests at most three short sentences. Local audio processing accounts for about 0.89 seconds before the request, so reducing that stage alone would not meet the target in the measured run. Earlier low/none trials used different context and timing bounds; they are historical comparisons, not predictions for a new run.

## Privacy and capture protection

- Raw audio is processed locally. No audio upload, recording library, or transcript database is implemented.
- Recent transcript and compact meeting memory are sent to OpenAI when answering questions or compressing context. Responses requests use `store:false` and `stream:true`. This does not imply that text never reaches OpenAI or override the service's data policies.
- SQLite stores settings, host registration ID, selected account ID, and meeting start/end metadata. Access tokens, refresh tokens, identity tokens, and account metadata are stored in Windows Credential Manager.
- Stop clears transcript, memory, question, answer, and latency state. Debug transcript display exists only in development builds and clears on Stop. Application logs contain numeric latency measurements, not meeting text.
- **Share protection active** means `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` succeeded and `GetWindowDisplayAffinity` confirmed it. It is not a security guarantee for every capture app. Consult [verification status](docs/verification.md) before relying on a capture path.

ChatGPT plan authorization follows OpenAI's current [open-source client flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). Eligibility and availability are controlled by OpenAI. This client uses dynamic registration, OAuth PKCE, a loopback callback, signed identity-token validation, refresh-token rotation, and a stable local host ID. Closed-source commercial distribution requires the applicable OpenAI participation terms.

## Build from source

Prerequisites: Windows x64, Node.js 22 or newer, Rust, Visual Studio C++ Build Tools, CMake, Python, and Edge WebView2. WiX is fetched by the Tauri bundler when needed.

```powershell
.\scripts\setup.ps1
npm run desktop
```

`setup.ps1` installs JavaScript dependencies, fetches Rust dependencies, prepares libclang for Windows FFI bindings, and downloads the tiny English Whisper model with a SHA-256 check. Model weights and build outputs are ignored by Git.

```powershell
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

The credential test creates and removes synthetic credentials under a random test key; it does not touch saved accounts. Native acceptance uses real WASAPI, VAD, Whisper, Win32 windows, and a local HTTP Responses fixture. Test authentication and event injection require both the `acceptance` feature and a debug build; release builds reject them.

For the wall-clock stability check, set `COPILOT_SOAK_MINUTES=60` and a free `COPILOT_CDP_PORT` before running `scripts/native-e2e.mjs`. The harness uses an isolated executable copy and reports numeric metrics under `artifacts/soak`. Capture tests use an isolated portable OBS installation, a synthetic screen background, and visible positive controls.

The complete acceptance ledger is in [docs/verification.md](docs/verification.md). Automated fixture checks alone do not establish real meeting accuracy, live-service latency, or compatibility with all screen-sharing products.

For ten minutes of controlled negative speech playback through WASAPI, set `COPILOT_NEGATIVE_MINUTES=10`. The harness checks false answer requests and context-compression cadence. Synthetic corpus fixtures can be generated with `scripts/create-corpus.ps1` and checked with the ignored `speech_corpus` integration test.

Live account latency checks use `scripts/live-service-check.mjs` against an already signed-in production app exposed on a local WebView2 CDP port. They save numeric measurements only. Manual request latency and speech-end-to-visible-answer latency are reported separately. The helper brackets both question confirmation and DOM appearance across polling round trips; four offline tests cover these bounds. `scripts/combine-live-service-results.mjs` selects the latest approved Luna/xhigh real-audio run and retains earlier trials and diagnostics.

For the controlled context-recall check, generate `.local/audio/context-statement.wav` with `create-audio-fixture.ps1` using the synthetic sentence "The team has agreed that our launch target for next quarter is February nineteenth." Set `COPILOT_LIVE_CONTEXT_CHECK=1` with real-audio mode. The helper plays the statement before the question and records only whether each answer recalls the date. These seeded samples are labeled separately from earlier question-only trials.

## License

MIT. Third-party source retains its original licenses. whisper.cpp and GGML are MIT; whisper-rs-sys is Unlicense. The bundled Whisper model originates from [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), based on OpenAI Whisper.
