# Implementation and verification ledger

## Latest Nemotron and camera upgrade (2026-10-07 local time)

The 0.2.1 MSI now includes Nemotron English Q8/Vulkan with independent cached SELF/REMOTE streams, all four requested chunk choices, screenshot/project shortcuts and the frozen FLX/DirectML camera pipeline. Actual native tests pass, including all 40 synthetic audio clips, ten minutes/127 negative clips with zero false answers, forced speech/camera parent-exit cleanup, and both real global shortcuts. Production resource/model hashes, frozen camera preview and disabled debug hooks pass. The signed-in model recalls all nested synthetic project facts and understands the controlled screenshot code and diagram.

The updated GPT-5.6 Luna/xhigh seeded-context run completed all three samples: **2,123 / 2,326 / 2,960.5 ms** speech-end-to-visible-answer, median **2,326 ms**. The two-second target remains unmet. Camera tests establish real DirectML eye inference, tracking/blend integration, blink passthrough and OBS transport; Camo currently has no visible face, so real user calibration/naturalness remain unverified. See [upgrade status](upgrade-plan.md), [live checks](live-upgrade-verification.md), [camera checks](camera-verification.md) and [package checks](package-verification.md).

The sections below retain historical Whisper-era evidence. Their installer, corpus, long-duration and latency figures do not certify the new Nemotron pipeline; the latest upgrade documents above supersede their current-status wording.

## New context shortcuts (2026-10-06)

Implemented and checked in the current source build:

- **Ctrl+Shift+P**: rereads the selected project folder, sends complete readable source to Responses, and retains it in meeting RAM. The native harness verifies nested file contents in outgoing requests, ignore/credential exclusions, binary-file reporting, follow-up reuse, and removal.
- **Ctrl+Shift+F8**: captures the monitor under the pointer, sends a full-resolution lossless PNG as `input_image`, and retains the latest screenshot for follow-ups. The native harness verifies PNG dimensions, focus/visibility preservation, image reuse, removal, and Stop during capture. Both new shortcuts were triggered through actual Windows keyboard events, not just command invocation. Ctrl+Shift+S was unavailable on this machine; F8 passed registration and dispatch.
- Overlay display is suspended while capturing, including when automatic generation starts concurrently. Capture and project jobs are scoped to a session and request ID; late results cannot repopulate a stopped meeting.
- Checks: frontend production build, 38 Rust tests (2 credential tests intentionally ignored), 2 state tests, 4 browser tests, and the extended native acceptance harness passed. Native answer requests use a local fixture; these checks do **not** prove live-account visual understanding. The existing installed production app/MSI has not yet been updated with these features.

At this historical checkpoint, the Nemotron and camera integrations and updated installer were still pending. Their implemented behavior and present verification limits are recorded in the latest upgrade documents above.

Updated 2026-10-06. The app implements the scope in all 31 sections of `text.txt`. The user authorized leaving unavailable service checks clearly marked. Real ChatGPT sign-in, account model discovery, streaming and account persistence across process restart passed. Live first-visible latency was measured; the two-second target was not met.

Current approved app model: **GPT-5.6 Luna / xhigh**. The user accepted this model on 2026-10-06 after the GPT-6 Luna availability checks. The final rebuilt package's saved account and settings survived restart at **12:06 UTC**; a fresh authenticated model-catalog request also passed, with the meeting stopped. Exact GPT-6 Luna availability is no longer a blocker for the current selection. The latency acceptance gate and the verification gaps below remain open.

## Plan coverage

| Sections | Implementation | Evidence/status |
| --- | --- | --- |
| 1–5: MVP, experience, stack, architecture, repository | Windows Tauri 2/React/TypeScript/Rust app, native audio-to-overlay pipeline | Native build, browser tests and fixture flow passed |
| 6–8: capture, preprocessing, transcription | Independent selected WASAPI loopback/microphone; 16 kHz mono; VAD; bundled local Whisper; partial/final source tags | Real device capture and local speech fixture passed |
| 9: meeting context | Five-minute/24 KB recent context; bounded older context and compact memory | Context unit tests passed |
| 10: question detection | Scoring, rhetorical filter, 500 ms end wait, SELF suppression | Unit/native checks and synthetic corpus passed |
| 11: continuations | Cancel, append and regenerate; late-token fencing; continuation after fast completed answers | Native fixture passed |
| 12: manual questions | Shared context, native shortcut registration, manual input | Browser/native command checks passed; physical shortcut input unverified |
| 13: ChatGPT auth | Dynamic registration, stable host, PKCE/state/nonce, signed identity validation, refresh rotation, Credential Manager | Security tests, isolated credential restart and real signed-in app restart passed |
| 14: account models | Returned account catalog and user model selection | HTTP contract and live four-model catalog passed |
| 15–17: Responses/prompt/plain text | Public Responses endpoint, store:false/stream:true, optional reasoning.effort, spoken-answer prompt, incremental text | HTTP/SSE, prompt, cancellation, rendering and real cloud streams passed |
| 18: overlay | Transparent, topmost, dynamic height, draggable, bottom-right, automatic no-activate | Native window/foreground/visibility checks passed; physical dragging unverified |
| 19: protection | Affinity 17 set and read back, honest status, native hide/show | Native and production package checks passed |
| 20: capture matrix | Actual OBS display and fresh WGC window capture | Passed for OBS; remaining paths listed below |
| 21: states | OFF, LISTENING, QUESTION, THINKING, ANSWER, ERROR | Browser/native tests passed |
| 22: controls | Native ask/hide/dismiss/pause/More registration and handlers; conflict notice and screen controls | Native action paths passed; actual key input unverified; Ctrl+Shift+X conflict reported |
| 23: persistence/privacy | SQLite settings and meeting timestamps only; credential secrets outside SQLite; RAM meeting content cleared on Stop | Schema, credential restart, Stop and production guard checks passed |
| 24–26: events/types/main loop | Event bus, typed snapshots, native actor, session/request fences | TypeScript/state and native integration passed |
| 27: summarization | Older-context compression, bounded memory, preserved in-flight context, retry, 30-second cadence | Unit tests and ten-minute native compression cadence passed |
| 28: latency | t0 speech end through t5 completion; numeric logs | Native fixture and real cloud first-visible timing measured; target missed |
| 29: success criteria | Measured results below | Partial: representative meeting/cloud/capture acceptance not all established |
| 30: build | MSI bundles model, notices and optimized portable CPU runtime; release rejects debug/test injection | Final MSI extracted/launched; 14 files, model checksum and runtime hashes verified |
| 31: complete flow | Sign in, choose model/devices, Start, automatic/manual answers, More, Stop | Native fixture passed; signed-in production manual and real-audio automatic streams passed |

## Measured results

- Final production package: approved **GPT-5.6 Luna / xhigh**, three actual-audio samples with a synthetic meeting fact captured before the question. **All three answers recalled the fact.** Corrected first-visible timing: **6,398 / 5,791 / 2,658.5 ms**, median **5,791 ms**; recorded uncertainty **24 / 25 / 24 ms**. Native speech-end-to-first-token median **5,798 ms**, request-to-first-token **4,903 ms**, request-to-completion **5,291 ms**, and local finalization **852 ms**. The **2,000 ms** gate remains failed. These seeded-context samples are labeled separately from earlier question-only trials; no performance regression or improvement is inferred from that changed context or three variable cloud samples.
- Earlier final-package trial: native speech-end-to-first-token median **5,253 ms**, request-to-first-token **4,364 ms**, request-to-completion **4,811 ms**, local finalization **882 ms**. First-visible median was approximately **5.26 seconds**. Its host clock anchor omitted confirmation-detection lag; historical DOM estimates and their original uncertainty are approximate. The corrected helper brackets confirmation and DOM appearance across polling round trips. Native elapsed timings are independent of that anchor.
- Prior production overlap trial: three actual-audio samples, first-visible median approximately **3,566 ms**. Median local finalization **873 ms**, cloud request-to-first-native-token **2,706 ms**, request-to-completion **3,405 ms**. This predates the final zero-noise guard and empty-final fix. Earlier measurements below are retained as baselines; historical DOM measurements share the anchor limitation above.
- Rust library: **33 passed** on the latest source; two credential tests are intentionally ignored by default and exercised separately under isolated random keys. Coverage includes the reasoning-effort HTTP contract, exact audio matching for speculative local inference, continued/noisy speech, optional partial cancellation, empty final transcripts at chunk boundaries, and account-operation completion after its caller is cancelled.
- Account renewal now runs in a task containing account state only. Cancelling an answer releases its meeting input immediately while renewal can validate and atomically persist replacement credentials. Shutdown blocks new token requests and waits for an active credential operation before exiting. Two targeted tests cover detached completion and result propagation. This follows OpenAI's requirement to serialize refreshes and save the latest replacement together. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
- Frontend state: **2 passed**. Browser acceptance: **3 passed**.
- Timing helper: **4 offline tests passed**, covering confirmation-detection lag, the first confirmation snapshot, the DOM absence round trip, and appearance before an evaluation response returns. The corrected helper also rejects a visible-answer estimate that precedes the native first token beyond the measured uncertainty. No additional cloud requests were made during the long audio replay.
- The controlled context-recall check uses a lexical match for the synthetic date in the completed answer after real audio capture; it does not establish broader semantic or human-meeting accuracy. Only match booleans and numeric timing are stored.
- Synthetic English corpus: **40/40 speech clips detected, 18/20 questions (90%), zero false candidates among 20 negatives**, median local transcription **410 ms** in the latest corpus run. Includes two voices, three rates and deterministic noise. This small synthetic corpus does not certify human meeting accuracy.
- Local fixture, Stop cancellation, and superseded-partial cancellation: **all three passed** in the latest serial run; fixture transcription **439 ms**. A prior concurrent run exceeded the cancellation test's one-second threshold; that threshold is not established under CPU contention.
- Real rendered fixture speech reached the overlay through WASAPI, VAD and Whisper. The latest native regression after the auth fix passed all **14 checks**, measuring **840 ms** from speech end to first native token with a **local HTTP fixture** (`artifacts/auth-final-native/results.json`). The earlier audio-pipeline regression measured 766 ms. Local inference starts during the unchanged 510 ms silence confirmation and reuses its text only when the eventual final audio and metadata match exactly. Preview text never reaches detection, context, the UI or the cloud. Noisy silence uses normal final inference. These individual fixture results are not public OpenAI latency or a live-service median.
- Latest audio-pipeline negative replay passed: **602,785 ms**, **128 clips**, **zero false automatic answer requests**, and **11 summary requests**. Its subsequent soak ran **3,600,001 ms**, with active capture, repeated fixture streams, affinity and foreground checks. **All 16 checks passed**, including final Stop/clear, completing at **09:41 UTC**. Evidence is in `artifacts/soak-latency-final/results.json`. The later production-only auth cancellation/shutdown refinement is covered by the targeted tests, fresh 14-check native regression, final package checks and real-service/restart checks. The fixture-token path exercised by the soak is unchanged; this is not a sixty-minute public-cloud or human-meeting certification.
- Prior native wall-clock soak: **3,602,117 ms (60 minutes)** without crashing. Retained as historical evidence; it preceded the current audio pipeline.
- A prior longer negative-playback run exposed partial transcription queue saturation. The queue now coalesces obsolete partial updates and preserves capacity for final transcripts. Its regression test and prior **603,277 ms** replay passed: **126 negative clips, zero false automatic answer requests, 11 summary requests**, then successful Stop/clear. The current optimized pipeline's replay above repeats this gate after the latest changes.
- OBS **32.2.2**, websocket **5.7.4**: unprotected positive controls visibly contained the overlay. Protected display capture matched the synthetic background; a fresh protected WGC window source refused capture. Existing WGC sources can retain an old frame after toggling protection; production applies protection before showing the overlay.
- Final production MSI: **14 packaged files**, bundled model checksum and all runtime DLL hashes verified; executable matched the build with only Tauri's known UNK-to-MSI bundle marker patch. Devices enumerated, protection readback succeeded, and debug/diagnostic/test-injection commands rejected. Native C/C++ flags explicitly include `/O2`. The build watches both the dependency runtime and shared bundle destination, restoring the correct release DLLs after debug tests. The auth-fixed MSI was freshly extracted to `.local/msi-auth-final`; package checks and saved-account restart passed at **12:06 UTC**. The package checker now requires a free debug port so it cannot silently connect to an older running app. Installer SHA-256: `E88E1C437DA126CCED1D2906577C013F9206C126790D968593B1AD7ABA62D7E9`.
- Earlier live production baseline: sign-in, four-model account catalog, completed manual and real-audio automatic streams, and saved account after process restart passed. The testing agent ran **GPT-6 Luna at xhigh**, as requested. The signed-in app catalog did not expose GPT-6 Luna; the separately labeled app comparison used **GPT-5.6 Luna at xhigh**. Three manual samples had an approximate ask-to-first-visible median of **2,768 ms**. Three actual audio samples had an approximate speech-end-to-first-visible median of **3,607.5 ms** (4,103.5 / 3,607.5 / 2,967.5 ms). Native request-to-first-token median **2,606 ms**, request-to-completion **3,234 ms**. No transcript, answer, identity or token was saved in the timing artifacts. These are historical baselines; the current result is the bounded seeded-context benchmark above.
- A separate three-sample **GPT-5.6 Luna at low effort** comparison measured median speech-end-to-first-visible **3,034.5 ms** and request-to-first-native-token **2,005 ms**. Both tested real-audio configurations missed the **2,000 ms** median target. Saved settings were restored to GPT-5.6 Luna/xhigh with the meeting stopped. Exact GPT-6 Luna remains unavailable in this account.
- Additional diagnostic comparisons with reasoning disabled measured speech-end-to-first-visible medians of **2,915 ms for GPT-5.6 Luna**, **3,070 ms for GPT-5.6 Sol** and **3,817.5 ms for GPT-5.6 Terra**, three actual-audio samples per model. None met the target. Luna's median local finalization was **1,000 ms**, final-transcript-to-question-confirmation **23 ms**, and request-to-first-native-token **1,910 ms**. The HTTP client is shared across requests; the measured cloud wait is the largest stage. These comparisons do not establish GPT-6 Luna or xhigh performance. The user stopped alternative-model comparisons; no further alternative requests are planned.
- Earlier signed-in `GET /v1/models` rechecks at **06:51 and 06:52 UTC** returned only GPT-6 Astra, GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna. GPT-6 Luna was not listed. These read-only checks made no answer requests and left the meeting stopped. Official [GPT-6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna) describes the model; its existence does not establish access through this account's ChatGPT plan catalog. The user subsequently approved GPT-5.6 Luna/xhigh, removing this model-selection blocker. The goal is not complete: the latency gate remains failed, and unavailable checks remain explicitly marked under the user's authorization.
- Earlier GPT-5.6 Sol baseline request-to-first-native-token was **2,173 ms**, request-to-completion **2,424 ms**. Its initial visual measurement used mismatched clock origins and was discarded. The final Luna measurements use a shared host-clock anchor with recorded timing uncertainty.

## MVP acceptance audit

These are the explicit section 29 gates, evaluated against the available evidence. Implementation coverage does not mean every acceptance gate passed.

| Requirement | Target | Current evidence | Status |
| --- | --- | --- | --- |
| Remote speech detected | >95% | 40/40 synthetic clips; actual WASAPI fixture capture | Passed for controlled corpus; human meeting rate unverified |
| Basic question detection | >85% | 18/20 synthetic questions | Passed for controlled corpus; human meeting rate unverified |
| False question triggers | <1 per ten minutes | Current source: zero requests over 602,785 ms / 128 controlled negative clips | Passed for controlled replay; human meeting rate unverified |
| First answer visible | <2 seconds median | Final GPT-5.6 Luna/xhigh seeded-context benchmark: 5,791 ms, corrected timing bounds | Failed |
| Overlay steals focus | Zero | Native foreground checks and one-hour soak | Passed in tested automatic-answer paths |
| Overlay appears in normal share | Zero | Actual OBS display and fresh WGC controls | Passed for OBS; other capture apps unverified as authorized |
| Audio leaves device | No | WASAPI feeds local resampler/VAD/Whisper; Responses bodies contain text only | Implemented and request contract verified |
| Answer streams | Yes | Production manual and actual-audio cloud streams | Passed |
| Can interrupt generation | Yes | Native continuation cancels HTTP stream and fences late output | Passed with real HTTP fixture |
| Manual hotkey | Yes | Native registration and manual handler tests | Handler passed; physical input unverified |
| Meeting runs sixty minutes | No crash | Current audio pipeline: 3,600,001 ms native wall-clock soak; subsequent auth fix has targeted tests | Passed for the local fixture loop; public-cloud/human meeting soak unverified |
| ChatGPT OAuth survives restart | Yes | Saved signed-in production account after actual restart | Passed |

## Capture matrix

| Capture path | Result | Evidence or unavailable dependency |
| --- | --- | --- |
| Teams screen/window | Unverified | Teams and authorized session unavailable |
| Meet screen/tab | Unverified | No authorized live sharing session |
| Zoom screen/window | Unverified | Zoom and authorized session unavailable |
| OBS Display Capture | Passed | Actual captured images with visible positive control |
| OBS Window Capture, fresh WGC source | Passed | Unprotected visible control; protected source refused capture |
| Snipping Tool | Unverified | Installed; computer-use native helper unavailable |
| Xbox Game Bar | Unverified | Installed; computer-use native helper unavailable |

Affinity readback is not proof for an untested capture product. Runtime testing used Windows 11 x64; a separate Windows 10 host and older physical CPUs have not been tested. Final baseline-only CPU fallback successfully transcribed the fixture with all optimized backend DLLs absent (**2,607 ms**). This establishes fallback functionality on this host, not the latency target on older CPUs.

## Evidence and reproduction

Local evidence is ignored by Git:

- `artifacts/native/results.json`: actual native integration with local HTTP fixture.
- `artifacts/latency-final/results.json`: audio-pipeline regression preceding the auth cancellation fix.
- `artifacts/live-service/audio-overlap-xhigh.json`: historical production overlap trial at the approved effort.
- `artifacts/live-service/audio-final-xhigh.json`: final package benchmark; native timings valid, original DOM clock anchor has the limitation described above.
- `artifacts/live-service/audio-final-bounded-xhigh.json`: final auth-fixed package, corrected timing bounds and controlled context-recall results; current approved benchmark.
- `artifacts/auth-final-native/results.json`: latest 14-check native regression after the auth fix.
- `artifacts/soak-latency-final/results.json`: completed long replay, sixty-minute soak and Stop/clear evidence.
- `artifacts/negative/results.json`: ten-minute controlled negative playback and compression cadence.
- `artifacts/soak/results.json`: wall-clock duration and numeric samples.
- `artifacts/corpus/results.json`: synthetic speech/question counts and timing.
- `artifacts/capture/results.json`: OBS versions, capture metrics and result; PNGs contain synthetic content.
- `artifacts/package/results.json`: extracted production package checks.
- `artifacts/package/guard-existing-endpoint.json`: negative control proving the package checker rejects an existing debug endpoint before launching an app.
- `artifacts/live-service/combinedresults.json`: completed model/effort comparisons and target status.
- `artifacts/live-service/manual.json`, `audio.json`, `audio-low.json`: individual timing samples and uncertainty.
- `artifacts/live-service/audio-none.json`, `audio-gpt-5.6-sol-none.json`, `audio-gpt-5.6-terra-none.json`: separately labeled diagnostic model comparisons.
- `artifacts/live-service/account-restart.json`: saved real account after process restart.
- `artifacts/live-service/catalog-latest.json`: fresh read-only exact-model availability check; reproduce with `node scripts/live-model-catalog.mjs`.

See README for build/test commands. Native harness options: `COPILOT_ASR_CORPUS=1`, `COPILOT_CRASH_TEST=1`, `COPILOT_NEGATIVE_MINUTES=10`, `COPILOT_SOAK_MINUTES=60` with `COPILOT_SOAK_REAL_AUDIO=1` for periodic varied Nemotron speech, `COPILOT_CAPTURE_TEST=1`, a free `COPILOT_CDP_PORT`, and `COPILOT_NATIVE_ARTIFACT_NAME` to retain separate run evidence.

Reports contain numeric timing/counts and verdicts; opt-in diagnostics may also retain public synthetic fixture transcripts and controlled answers. Do not persist user meeting text, summaries, answers, identity or credentials. Raw audio stays local; text context reaches OpenAI for answers and compression. `store:false` does not override service data policies.
