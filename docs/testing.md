# Testing and verification

Run commands from the repository root after completing [source setup](../README.md#build-from-source). The real-audio and signed-in service checks below are opt-in; they use the hardware and account described for each check.

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

The complete acceptance ledger is in [docs/verification.md](verification.md). Automated fixture checks alone do not establish real meeting accuracy, live-service latency, or compatibility with all screen-sharing products.

The [adaptive GPU interview evaluation](adaptive-interview.md) runs 24 scenarios with progressively deeper follow-ups through signed-in Codex, using Luna by default. It records exact questions, answers, timing, reviews, and resumable checkpoints; the near-instant latency target remains unmet in the live evidence collected so far.

The [learned local intent-gate experiment](intent-gate-experiment.md) measures CPU classification and early-versus-final sending without canned answers or phrase routing. It remains disabled in release builds: the corrected audio comparison showed insufficient readiness coverage and no demonstrated latency improvement.

For ten minutes of controlled negative speech playback through WASAPI, set `COPILOT_NEGATIVE_MINUTES=10`. The harness checks false answer requests and context-compression cadence. Synthetic corpus fixtures can be generated with `scripts/create-corpus.ps1` and checked with the ignored `speech_corpus` integration test.

Live account latency checks use `scripts/live-service-check.mjs` against an already signed-in production app exposed on a local WebView2 CDP port. They save numeric measurements only. Manual request latency and speech-end-to-visible-answer latency are reported separately. The helper brackets both question confirmation and DOM appearance across polling round trips; four offline tests cover these bounds. `scripts/combine-live-service-results.mjs` selects the latest approved Luna/xhigh real-audio run and retains earlier trials and diagnostics.

For the controlled context-recall check, generate `.local/audio/context-statement.wav` with `create-audio-fixture.ps1` using the synthetic sentence "The team has agreed that our launch target for next quarter is February nineteenth." Set `COPILOT_LIVE_CONTEXT_CHECK=1` with real-audio mode. The helper plays the statement before the question and records only whether each answer recalls the date. These seeded samples are labeled separately from earlier question-only trials.


