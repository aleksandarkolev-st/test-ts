# Realtime latency and reliability

The 2026-10-07 changes preserve growing speculative questions instead of cancelling each ASR update, reduce repeated answer context, use low effort with Fast by default, and reduce the silence confirmation wait from 500 to 200 ms. The authenticated native Codex app-server remains persistent during a meeting. Refill behavior is unchanged.

## Correct speculative output

RNNT updates can complete an unfinished word, such as `la` → `launch`. Both word completion and prefix extension keep the same running job. A non-prefix correction, or newly appended correction words such as `actually`, `instead`, `rather` or `not`, supersedes it. Explicit self speech and a non-question final retract speculation. A recent declarative statement no longer masks the next partial question.

The question watch channel coalesces growth. After 600 ms without changes, one answerable partial refinement may be sent with `turn/steer`. This quiet interval is separate from the 200 ms final-confirmation fence. The earlier 200 ms refinement interval repeatedly sent an intermediate phrase and then the final phrase, adding another model iteration. Final confirmation sends the latest question immediately if it differs. If the provisional turn has already completed, a small follow-up turn uses the same ephemeral thread and existing meeting context. This does not resend the entire context. [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) describes steering an active turn; an acknowledgement alone does not establish that the output answers the new question.

The adapter therefore waits for the updated user-message item to be consumed before tagging later text with the updated question. The runtime rejects text tagged with an obsolete question. Growing input clears the earlier buffer, and only confirmed text is visible. Retrieval is refreshed for the completed topic; changed selected excerpts accompany a refinement, while unchanged excerpts and explicit attachments are not resent. Confirmation publishes the final question and excerpts atomically, avoiding a race that could send the final question with provisional retrieval. A live test changes the supplied launch date and verifies the refined answer uses the refreshed fact. Final completion requires a consumed final question and nonempty answer. This can take longer than simply displaying the earliest provisional text; benchmark results count the correct retained answer separately.

The HTTP fallback cannot steer an active request, so it preserves partial growth and restarts once at final confirmation. Unit tests cover this compatibility path separately.

## Context and reliability

Answer retrieval selects relevant, recent lines within separate budgets: 2,000 characters of compact memory, 1,500 awaiting compression and 4,000 recent conversation. Labels and the complete current question are added, with less than 8,000 characters of context before the question. The archive and summary retry limits remain unchanged, and explicitly attached project text and screenshots remain complete. Selection uses lexical overlap and recency, so it is bounded retrieval rather than a guarantee that every relevant historical fact is included. Tests cover a large meeting, an older relevant date, Unicode and speaker labels.

Speech GPUs are stored by name and resolved against the actual `nemo-speech doctor --json` catalog at startup. During verification, the RX 9070 XT moved from historical index 1 to index 0; index 1 now identified integrated graphics. Legacy nameless indices migrate to a discrete GPU. An explicitly named GPU that disappears produces an actionable error. The UI lists current adapters. This fixes silent adapter substitution, which had caused streaming stalls in the initial audio pilots.

The local WebSocket read and write directions are independently polled with bounded writes and cancellation. This is a defensive duplex improvement; the stress test also passed against the earlier implementation, so it does not establish that duplex handling caused the observed stalls. The adapter identity was the demonstrated hardware issue.

Numeric diagnostic writes now ignore a closed stderr pipe. The initial manual pilot reproduced an actor panic after successful inference when its launcher's stderr reader closed; the fixed pilot completes and restores controls under that condition.

Active remote capture holds a scoped Windows system/display wake request on the capture thread. Pause, Stop and capture failure release it on that same thread. This prevents automatic idle sleep and disappearing display-audio endpoints during a meeting; explicit user sleep remains honored. A native test verifies the actual thread execution flags and their restoration. The benchmark wrapper similarly keeps the system and display awake only for its run, including paused manual trials. [Microsoft documents these execution requirements and their scope](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate).

## Verification

- Rust library: 66 passed, five opt-in tests excluded from the normal run.
- Three signed-in live Codex checks passed: streaming cancellation and owned process exit; final growth and an already completed provisional turn; stable refinement before confirmation without restart.
- Two frontend state tests and six browser end-to-end checks passed, including low effort, Fast and named GPU settings.
- Four timing-bound tests passed.
- All 27 native acceptance checks passed with actual WASAPI/Nemotron playback, three question grammar classes, self suppression, queued/speculative answers, HTTP continuation, stale tokens, project and screenshot shortcuts, focus behavior, pause/resume and Stop cleanup. These answer-service checks use a controlled local HTTP fixture, not live OpenAI latency.
- Frontend and embedded release builds passed. The last scheduler subword change was covered by its added unit test and final release audio trials.

The previous MSI has not been rebuilt. Benchmarks use the embedded loose release executable; its hash and hashes of the inference, scheduler, detector, context, speech and UI sources are retained in each final run.

## Benchmark method

`scripts/realtime-latency-benchmark.mjs` follows the existing 100-total-sample pattern: 20 manual trials each for none, low and medium effort (60), followed by 20 real-audio trials each at 80 and 160 ms with low effort (40). All use the signed-in Codex route, GPT-6 Luna, Fast and unchanged first-token refill. Each trial starts a fresh session, prepares three threads and settles for 1,000 ms. Configuration order rotates each round. Manual trials pause audio and use an identical prompt. Audio trials seed the same synthetic February 19 fact before the same spoken question through actual WASAPI playback on the named discrete GPU.

Native trace timestamps share the meeting clock. `firstAgentDelta` includes provisional output; `retainedFirstDelta` is the first accepted token for the final question. `firstVisible` is native receipt after two overlay animation frames, an upper bound on paint. Independent DOM polling bounds are included. Speech-end latency starts at native VAD speech end, not playback-process exit. Turn-send latency includes internal Codex preparation, transport and server/model work; the trace cannot isolate server inference.

Nearest-rank p95 and paired differences are computed by `scripts/summarize-realtime-benchmark.mjs`. Bootstrap intervals use 10,000 deterministic draws of round pairs. Every completed final-run sample, including outliers, is retained. Correctness means recall of one synthetic fact, not general speech or meeting-answer accuracy. Earlier failed and diagnostic pilots are retained separately and described below.

Run against an idle signed-in release app exposed on a local WebView2 CDP port:

```powershell
$env:COPILOT_CDP_PORT='9558'
$env:COPILOT_BENCH_EXECUTABLE='C:\path\to\meeting-copilot.exe'
$env:COPILOT_BENCH_SAMPLES='20'
$env:COPILOT_BENCH_MODE='efforts'
node scripts/realtime-latency-benchmark.mjs
$env:COPILOT_BENCH_MODE='audio'
node scripts/realtime-latency-benchmark.mjs
node scripts/summarize-realtime-benchmark.mjs
```

The harness sends WAV data directly to the selected named output with Windows `waveOut`, and captures that same endpoint; it records device names and player hashes. `COPILOT_BENCH_OUTPUT=T24E390` explicitly selects the requested monitor. This avoids SoundPlayer's default or per-app headphone routing. Each run stops the meeting and restores saved controls. `--resume` requires identical executable, source, prompt and configuration hashes and retains prior failures. `scripts/run-realtime-benchmark.ps1 -Mode all` runs both phases with a scoped system/display wake request; `audio` and `efforts` run one phase, and `-Resume` resumes a compatible interrupted run.

## Final 100-sample release results

The final matrix completed without restart, disconnect, censored request or cleanup failure. All 100 answers recalled the controlled February 19 fact. Playback/capture used **1 - T24E390 (2- AMD High Definition Audio Device)** and speech used the named **AMD Radeon RX 9070 XT**, resolved to Vulkan index 0. Both phases have identical executable, source, player and device metadata; the recorded source hashes also match the final working files.

Twenty trials per row; all times are milliseconds. Manual rows measure turn send to the first retained token. Audio rows measure native speech end to the confirmed answer becoming visible.

| Mode | Configuration | Median | p95 | Maximum | Fact recall |
|---|---|---:|---:|---:|---:|
| Manual | none / Fast | 1683.5 | 2260 | 2546 | 20/20 |
| Manual | low / Fast | 1868 | 3017 | 3169 | 20/20 |
| Manual | medium / Fast | 1641 | 2028 | 2162 | 20/20 |
| Audio | low / Fast, 80 ms | 1945 | 5198 | 6329 | 20/20 |
| Audio | low / Fast, 160 ms | 2709 | 6052 | 54895 | 20/20 |

The 54,895 ms audio outlier is included. The 500–900 ms perceived-latency target was not reached. At 80 ms, provisional first text had an 888 ms median after speech end, but that text was not necessarily an answer to the final question; displaying it as the benchmark result would overstate performance. The native trace cannot isolate model inference from preparation, transport or server work.

| Audio configuration | Answer jobs | Cancelled jobs | Questions using one job | Steers | Same-thread follow-ups | Final-job head start median |
|---|---:|---:|---:|---:|---:|---:|
| 80 ms | 24 | 4 | 16/20 | 9 | 4 | 1155.5 ms |
| 160 ms | 27 | 7 | 13/20 | 8 | 3 | 824.5 ms |

Across audio trials, 29/40 questions retained one job and 35/40 started some inference before speech ended. Remaining superseded jobs are included in the counts. The historical refill audio matrix recorded 120 jobs and 100 cancellations per 20 questions at each chunk size; the final matrix records 51 jobs and 11 cancellations across 40 questions. This is a substantial reduction in observed job churn, with different builds, run times and output routing. It does not isolate a causal latency improvement: the historical audio medians were 2099.5 ms at 80 ms and 2257.5 ms at 160 ms, so the current run is not consistently faster across both configurations.

Initial audio prompts had medians of 301 and 300.5 characters; successfully submitted refinement text totalled medians of 563 and 197 characters per final job. These short synthetic fixtures demonstrate the refinement path, not the large-meeting context reduction; the separate bounded-context tests verify the latter. First ASR partial medians were 678 ms (17 trials with partials) and 763 ms (15 trials with partials); partial-to-credible-candidate medians were 560 and 638 ms. Trials with no partial remain in the end-to-end results.

Paired median differences and bootstrap 95% intervals:

- None minus low, manual: −288.5 ms, interval [−600, 68].
- Low minus medium, manual: 339.5 ms, interval [−8, 586].
- 160 minus 80 ms chunks, audio visibility: 316 ms, interval [39.5, 1138].

This sample supports trying 80 ms on this machine. Neither manual effort comparison establishes a reliable ordering, and one fact-recall query cannot choose general answer quality. Low/Fast remains the realtime default; the existing 160 ms speech default is retained.

Raw evidence: [manual trials](../artifacts/live-service/realtime-efforts-20.json), [audio trials](../artifacts/live-service/realtime-audio-20.json), [summary and paired comparisons](../artifacts/live-service/realtime-benchmark-summary.json), [numeric sample CSV](../artifacts/live-service/realtime-benchmark-samples.csv), and [27 native acceptance checks](../artifacts/realtime-native-validation/results.json). Earlier failures below remain separate evidence; completing this final matrix does not erase them or establish general meeting accuracy.

## Earlier effort diagnostic before quiet-interval consolidation

All times are milliseconds from actual turn send to the first retained native text token. Twenty completed trials per effort recalled the date correctly. Percentiles are conditional on completion; the separately retained low-effort request that produced no text within the original 60-second harness window is excluded from these latency percentiles and included in the failure record.

| Effort | Completed | Median | p95 | Maximum | Controlled fact recall |
|---|---:|---:|---:|---:|---:|
| none | 20 | 1866 | 37731 | 49472 | 20/20 |
| low | 20 | 1839.5 | 3139 | 4786 | 20/20 |
| medium | 20 | 1724 | 2768 | 3175 | 20/20 |

These trials do not establish that disabling reasoning is faster. None has long outliers; medium has the lowest observed median on this simple fact query. The controlled query is insufficient to choose an effort for general meeting-answer quality. Low remains the realtime default requested by the brief. Historical xhigh first-token refill measured a 1939.5 ms median and 3279 ms p95; this is an unpaired comparison across different times and builds, so it cannot isolate an effort or implementation effect.

## Interrupted and diagnostic runs

The earlier effort matrix resumed twice on identical executable and source hashes. After ten completed samples, the WebView CDP connection disconnected during `low_4_startup`; reconnecting showed a local speech-stream stall. Windows Kernel-Power event 42 records System Idle sleep at 16:55:59 UTC, matching that interruption. The session was stopped before resuming. After 48 completed samples, `low_17_answer` reached the original 60-second harness limit with a turn acknowledgement but no delta. Its snapshot is retained; it is a censored answer trial, not a successful 60-second answer. The harness now waits 130 seconds, covering the adapter's existing 120-second deadline. The successful retries supplement these interruption records and do not erase them. Checkpoints are `realtime-efforts-20-startup-disconnect.json` and `realtime-efforts-20-answer-timeout.json`; all 60 completed earlier trials are in `realtime-efforts-before-coalescing.json`.

The earlier audio matrix recorded ten correct completed samples, then disconnected at Stop. Kernel-Power event 42 records System Idle sleep at 17:19:46 UTC, exactly when the tenth result was saved. A resumed trial later captured no question: the default WAV playback endpoint had switched back to the reconnected monitor while capture remained on the previously selected USB endpoint. No answer request was started in that trial. The raw ten samples, including a 34,566 ms retained-answer outlier, remain in `realtime-audio-before-coalescing.json`; the sleep checkpoint is `realtime-audio-20-sleep-stop.json`. This diagnostic matrix is not presented as a complete 20-per-chunk comparison. The final matrix uses the longer refinement quiet interval, scoped wake requests and explicit playback/capture through the same named T24E390 monitor endpoint.

Earlier pilots are separate from the final matrix:

| Artifact | Outcome and purpose |
|---|---|
| `realtime-efforts-pilot.json` | Inference delivered text, then numeric stderr logging panicked the actor; cleanup failed. |
| `realtime-efforts-pilot-diagnostic.json` | Refused the still-active app while diagnosing the prior failure. |
| `realtime-efforts-pilot-fixed-logging.json` | Three correct manual samples and successful cleanup with the stderr reader closed. |
| `realtime-audio-pilot.json`, `realtime-audio-pilot-duplex.json` | Local speech stalls on the integrated adapter; duplex change alone did not fix them. |
| `realtime-audio-pilot-named-gpu.json` | Two correct audio samples on the discrete GPU, but late candidate detection. |
| `realtime-audio-pilot-stable.json` | Startup failed with `0x88890004` after the saved playback endpoint disappeared. |
| `realtime-audio-pilot-current-devices.json` | Two correct audio samples using current devices; exposed subword-triggered cancellations. |
| `realtime-audio-pilot-subword.json` | Two correct audio samples with one preserved job each; included a slow retained-answer outlier. |

Successful controlled tests do not establish uninterrupted live-service reliability. The recorded startup disconnect and censored request remain verification limits, even though their retries completed.
