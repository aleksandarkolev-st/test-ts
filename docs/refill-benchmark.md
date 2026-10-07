# Refill contention and partial-transcript timing

Measured on 2026-10-07 using the signed-in native Codex route, GPT-6 Luna, Fast mode and xhigh effort. All times below are milliseconds. The updated executable embeds its frontend assets; its SHA-256 is `54e7a8c17eccaaabd1d1ef30307797f768ba8c5ba5b1d5fb96b4ddb987628684`.

## Implementation and timing boundaries

Startup prepares three ephemeral threads. The default policy starts refill after the first agent delta, or after a terminal `turn/completed` notification if no delta was delivered. Cancellation keeps the event receiver and transport slot until the terminal event or a bounded five-second wait; an interrupt acknowledgement alone cannot trigger fallback refill. The opt-in live Rust test verifies the three-entry reserve, streaming cancellation, terminal notification and owned process exit.

The native trace records candidate detection, stream entry, semaphore acquisition, prepared-thread consumption, refill start, actual turn send, turn acknowledgement, first agent delta, question confirmation, first visibility and refill completion. It additionally records prepared-thread age and terminal notifications. These are elapsed milliseconds on the meeting clock. A refill task can finish without preparing a thread if another task already filled the reserve; that no-op has a null refill-start timestamp and zero threads created. Thread acknowledgement and refill completion establish pool preparation, not internal Codex WebSocket readiness. Send-to-delta still includes internal prewarm resolution, transport and server/model work.

First visibility is native receipt of a notification after two overlay animation frames, an upper bound on paint time. Independent DOM polling bounds are retained in the raw samples. Partial timestamps are native actor receipt times, not timestamps inside Nemotron.

## Twenty samples per refill policy

A is immediate refill, B is first-token refill, C is disabled refill. Each trial starts a fresh meeting with the same three-thread reserve, fixed synthetic prompt and 1,000 ms settle interval after startup. Capture is paused. Order rotates ABC/BCA/CAB to distribute service-time variation. Disabled refill cannot exhaust its reserve because each session contains one request. No samples are discarded. These are controlled manual requests, not speech-end latency measurements.

| Policy | Samples | Median send → delta | p95 send → delta | Median candidate → native visibility | Fact recall |
|---|---:|---:|---:|---:|---:|
| A | 20 | 2090.5 | 2841 | 2114 | 20/20 |
| B | 20 | 1939.5 | 3279 | 1967 | 20/20 |
| C | 20 | 1894.5 | 4297 | 1922.5 | 20/20 |

Neither paired refill comparison establishes an improvement over immediate refill in this run. Deferring replacement work removes a potential source of overlap, but these measurements do not identify it as the dominant delay.

| Stage duration | A median | B median | C median |
|---|---:|---:|---:|
| candidateToStreamMs | 0 | 0 | 0 |
| semaphoreWaitMs | 0 | 0 | 0 |
| preparedThreadWaitMs | 0 | 0 | 0 |
| preparedToSendMs | 0 | 0 | 0 |
| sendToAckMs | 13 | 11 | 12.5 |
| ackToFirstDeltaMs | 2077.5 | 1928.5 | 1881 |
| deltaToNativeVisibilityMs | 27.5 | 26 | 29 |
| refillDurationMs | 87 | 88 | — |

The earlier complete 20-per-policy run, before the cancellation terminal fence, measured median send-to-delta A/B/C of 1896/1963/1956 ms. It is retained as `refill-policies-20-before-terminal-fence.json`. Both audio pilots are retained; the corrected-build pilot includes a 7,517 ms send-to-delta outlier. The final run below uses only the corrected executable, and retains all slow trials.

## Twenty real-audio samples per chunk size

Both groups use deferred refill, fresh sessions, the same context statement and question WAV files, active Windows capture and the same GPU. Nemotron maps 80 ms to zero right-context chunks and 160 ms to one. This mapping is covered by the Rust test and passed to the native speech launcher. Each group recalled the seeded February 19 date in 20/20 samples; this controlled fact check is not a general speech-recognition accuracy evaluation.

Positive head start means before detected speech end; negative means after it. The first credible candidate and earliest stream can precede the retained answer's stream by different amounts because later transcript revisions replace jobs.

| Chunk | First partial after speech start | First candidate head start | Earliest stream head start | Retained stream head start | Speech end → native visibility median | p95 | Total attempts |
|---|---:|---:|---:|---:|---:|---:|---:|
| 80ms | 675 | 1755 | 1755 | -230.5 | 2099.5 | 2809 | 120 |
| 160ms | 754.5 | 1675.5 | 1675.5 | -301 | 2257.5 | 3533 | 120 |

80 ms median first-candidate-to-retained-stream time is 1981.5 ms; at 160 ms it is 1973 ms. The attempt records show 100/100 cancelled attempts respectively. Early partials reach the local question threshold and start generation. Much of that speculative head start is lost when material transcript growth cancels a still-incomplete answer and creates another job. This fixture does not support attributing the lack of retained head start solely to late Nemotron partial emission.

## Paired comparisons and limits

Pairs are matched within each rotated round. Intervals use 10,000 deterministic bootstrap draws of the 20 paired differences, seed 20261007. They describe these trials, not service-wide guarantees. The difference is first minus second; positive favors the second configuration for latency, while negative favors it for head start.

| Pair | Metric | Median paired difference | Bootstrap 95% interval | Second configuration better |
|---|---|---:|---:|---:|
| A − B | sendToFirstDeltaMs | -27.5 | -451.5 to 305 | 10/20 |
| A − C | sendToFirstDeltaMs | -114 | -552.5 to 458.5 | 10/20 |
| 160ms − 80ms | firstPartialFromSpeechStartMs | 81 | 71 to 82 | 20/20 |
| 160ms − 80ms | firstCandidateHeadStartMs | -81 | -82 to -71 | 20/20 |
| 160ms − 80ms | speechEndToNativeVisibilityMs | 55 | -208.5 to 747 | 10/20 |

Effort was held fixed; this experiment does not compare low with xhigh. [OpenAI Docs](https://developers.openai.com/api/docs/guides/deployment-checklist) says lower effort generally reduces latency. The earlier small-run reversal is not evidence that xhigh is intrinsically faster.

The traces locate most first-token delay after turn acknowledgement. They cannot separate internal Codex waits from service/model latency or prove that Codex itself is the wrong serving layer. [OpenAI Docs for Live delegation](https://developers.openai.com/api/docs/guides/live-delegation) describes persistent Responses WebSockets and advance preparation, with Luna as a backend example. A direct-route comparison on the same inputs would be needed to attribute serving-layer overhead. No architecture switch was made. The hard sub-second target remains unproven.

## Raw measurements

Every recorded trace, attempted generation, fixture hash, source hash, DOM observation and restored-control check is in `artifacts/live-service/refill-{policies,audio}-20.json`. `refill-benchmark-summary.json` and `refill-benchmark-samples.csv` contain the analysis and numeric sample export. The audio run stopped after 18 completed samples because the harness incorrectly required every refill task to create a thread, then after 30 samples because a second guard also rejected no-ops. Both checks were corrected and the remaining samples resumed on the same executable, source, fixtures and configuration. Both stopped checkpoints are retained as `refill-audio-20-{noop-check-stopped,second-noop-check-stopped}.json`. The first stopped trial's final numeric snapshot was not preserved by the original harness; the second is retained as an inflight numeric record. These two interrupted trials are excluded from the 40 completed analysis samples for harness validation reasons, not latency. All completed analysis samples and their slow outliers are retained. Saved settings are restored and the meeting and broker are stopped after each run. The existing MSI has not been rebuilt for this change.

### Send to first delta, all policy samples

| Round | A | B | C |
|---|---:|---:|---:|
| 1 | 2139 | 1941 | 1487 |
| 2 | 2188 | 1339 | 4199 |
| 3 | 1651 | 2318 | 2076 |
| 4 | 2707 | 3279 | 4297 |
| 5 | 2063 | 1826 | 1798 |
| 6 | 2841 | 1682 | 1915 |
| 7 | 1583 | 1503 | 3958 |
| 8 | 2202 | 3706 | 1449 |
| 9 | 2133 | 2299 | 2725 |
| 10 | 1730 | 1624 | 2344 |
| 11 | 1517 | 2099 | 1514 |
| 12 | 2462 | 1492 | 1643 |
| 13 | 1543 | 1957 | 2056 |
| 14 | 2556 | 2025 | 1874 |
| 15 | 1459 | 2492 | 1690 |
| 16 | 1520 | 1938 | 1491 |
| 17 | 2118 | 1745 | 4395 |
| 18 | 3178 | 1508 | 1559 |
| 19 | 1704 | 1839 | 1632 |
| 20 | 1569 | 2054 | 2038 |

### Partial receipt, retained head start and visibility, all audio samples

| Round | 80 partial | 160 partial | 80 retained head start | 160 retained head start | 80 visibility | 160 visibility |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 680 | 757 | -246 | -295 | 2016 | 3533 |
| 2 | 674 | 755 | -241 | -314 | 2809 | 2405 |
| 3 | 668 | 749 | -219 | -308 | 2171 | 2086 |
| 4 | 671 | 760 | -238 | -307 | 1965 | 2724 |
| 5 | 670 | 751 | -237 | -290 | 1811 | 2315 |
| 6 | 677 | 791 | -209 | -322 | 2359 | 2066 |
| 7 | 670 | 751 | -216 | -308 | 2141 | 1895 |
| 8 | 704 | 754 | -252 | -298 | 3173 | 2156 |
| 9 | 675 | 762 | -216 | -312 | 1560 | 4333 |
| 10 | 674 | 724 | -202 | -213 | 2058 | 3176 |
| 11 | 675 | 756 | -242 | -301 | 1771 | 2506 |
| 12 | 668 | 767 | -220 | -309 | 2371 | 2200 |
| 13 | 682 | 733 | -225 | -213 | 2155 | 2082 |
| 14 | 677 | 753 | -227 | -299 | 2032 | 2707 |
| 15 | 682 | 751 | -234 | -320 | 2172 | 2056 |
| 16 | 678 | 734 | -242 | -219 | 2025 | 3308 |
| 17 | 676 | 759 | -208 | -301 | 2170 | 2946 |
| 18 | 682 | 755 | -242 | -291 | 1879 | 1619 |
| 19 | 673 | 760 | -218 | -319 | 2527 | 2155 |
| 20 | 666 | 727 | -236 | -215 | 1833 | 2016 |

## Reproduce

Build the embedded release with `npm run build` and `cargo build --release --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol`. Use the signed-in app with its bundled runtimes, configured capture devices, controlled audio fixtures in `.local/audio`, and WebView2 CDP port 9557. Set `COPILOT_BENCH_EXECUTABLE` to the running executable path.

Run `scripts/refill-contention-benchmark.mjs` with `COPILOT_BENCH_MODE=policies`, `COPILOT_BENCH_SAMPLES=20`, and `COPILOT_BENCH_FILE=refill-policies-20.json`; then use mode `audio` and filename `refill-audio-20.json`. Run `node scripts/summarize-refill-benchmark.mjs` afterward. The harness refuses an active meeting or a development URL, validates timing order and refill policy, records progress after every sample, and restores controls on failure.
