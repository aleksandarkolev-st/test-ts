# Speculative meeting answers

The two attached scheduler briefs were implemented on 2026-10-07. Question detection stays local. Remote partial and final transcripts can start a speculative answer, while the existing 500 ms silence and final-transcript fence still control confirmation. Model text stays buffered until confirmation. SELF speech suppresses candidates; resumed speech and a non-question final retract speculative work. Punctuation-only transcript changes retain the turn; material corrections cancel and replace it.

Meeting startup initializes the owned Codex broker, reads its isolation configuration once, and prepares three ephemeral answer threads with the selected model, speed, reasoning effort and answer instructions. Answer generation consumes a prepared thread and starts background refill after the first agent text delta, falling back to refill when the turn terminates without a delta. The internal `codexRefillPolicy` setting supports `immediate`, `first_token` (default), and `disabled` for controlled comparisons. Exhaustion waits for background preparation; answer generation does not create a cold thread. A `thread/start` acknowledgement does not establish that Codex's internal WebSocket prewarm has completed. Summaries and expanded answers use separate instructions. Stop cancels work and closes the broker and its owned process.

Numeric per-answer timing records cover candidate detection, stream entry, semaphore acquisition, prepared-thread consumption and age, turn send and acknowledgement, first agent delta, terminal notification, confirmation, visibility, and refill start/completion. `get_snapshot` includes the current answer's pipeline timing; `get_answer_timings` returns up to 256 recent attempts. The visibility marker is native receipt of an overlay notification after two animation frames, so it is an upper bound on paint time. These stages do not expose Codex's internal prewarm wait or pure model inference time. Cancellation fallback waits for the terminal notification, not just the interrupt acknowledgement. The measurements below precede this refill change; the completed 20-sample policy comparison and 80/160 ms speech comparison are in [the refill benchmark report](refill-benchmark.md).

The scheduler permits two active answers and one unstarted pending burst. The first candidate starts immediately; subsequent candidates use a 200 ms burst window. Explicit continuation phrases such as “and actually”, “break that down”, “assuming” and “what about” merge with the latest related request. Growing partial follow-ups preserve the original question. A newer pending burst supersedes the older pending burst when capacity is full. Cancelled slots remain occupied until transport cleanup finishes. Codex also enforces a two-turn semaphore across answers and summaries.

Each job has speculative, confirmed, superseded, cancelled or complete state. The overlay lists question statuses and displays one confirmed answer. An early replaced answer is interrupted; a nearly finished three-sentence answer with two completed sentences may finish while its replacement waits. This sentence count is a local progress estimate, not model-reported percentage. Relation detection is a local phrase heuristic, so implicit or unusually worded follow-ups can be classified as independent questions.

## Live measurement

The production executable used native Codex, authenticated `gpt-6-luna`, Fast acknowledged as `priority`, Nemotron English Q8, 160 ms chunks and Vulkan GPU 1. Each effort received the same synthetic context statement through actual WASAPI playback before five spoken questions. Timing starts at native speech end and ends at the first observed overlay DOM text. Native first-token timing includes adapter/slot wait, rather than isolating model-server inference.

Results are recorded in `artifacts/live-service/codex-gpt6-luna-fast-{low,xhigh}-speculative.json`. No sample is discarded, including slow first requests. These controlled samples establish seeded context recall and measured latency, not human meeting accuracy or a service latency guarantee. Request and token timestamps can precede confirmation, because generation overlaps the confirmation window.

## Verification

Rust tests cover partial/final correction, SELF suppression, bounds, burst timing, punctuation reuse, follow-up replacement, preservation of nearly completed work, growing follow-ups and completion before confirmation. The native scheduler acceptance check uses actual Windows capture and a controlled HTTP fixture to verify pre-confirmation inference and buffering, two concurrent requests, one pending burst, one displayed answer, follow-up cancellation and Stop cleanup:

```powershell
$env:COPILOT_NATIVE_ARTIFACT_NAME='scheduler'
node scripts/native-e2e.mjs --scheduler-only
```

The broader native acceptance run timed out waiting for injected Ctrl+Shift+P to reach the project handler. Its snapshot remained healthy and idle with no project or attachment work. That run is not claimed as passing; scheduler acceptance is recorded separately in `artifacts/scheduler/results.json`. Browser tests for attachment controls pass.

The protocol follows [OpenAI's app-server lifecycle](https://learn.chatgpt.com/docs/app-server). Model effort support is documented on the [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Final release measurements, 2026-10-07

| Effort | Speech end to first visible text, five samples (ms) | Median visible latency | Median request to first native token | Context recall |
| --- | --- | --- | --- | --- |
| low | 3528.5 / 6194 / 3234 / 2235 / 2208 | 3234 ms | 3046 ms | 5/5 |
| xhigh | 3059 / 2001 / 1964 / 3161.5 / 1990.5 | 2001 ms | 2020 ms | 5/5 |

The final audited release measured **3.234 s at low** and **2.001 s at xhigh**. The preliminary release measured 1.812 s at low and 2.4165 s at xhigh, with a 9.9815 s low outlier. Keep both runs: the reversed effort ordering shows substantial variability and does not establish a reliable speed advantage. Neither final median meets the two-second target, and the 0.4-1.2 s aspiration remains unmet. Final DOM clock uncertainty is 25-29 ms. All ten final answers recalled the seeded date. Generation began 279-486 ms before confirmation at low and 279-677 ms before confirmation at xhigh.

The preliminary results remain in `codex-gpt6-luna-fast-{low,xhigh}-speculative-initial.json`. A four-sample run accidentally relaunched the earlier executable after Windows briefly kept it locked; it was deliberately stopped and is retained as `codex-gpt6-luna-fast-low-interrupted-relaunch.json`. The final launched executable hash matches the compiled release: `17cfa4c0e28de671bd5c156a61e7f5b8e1d5712e9523897e3bddc9bb8d693def`. `artifacts/live-service/speculative-summary.json` records current source hashes, numeric measurements and restored idle Codex/Fast/xhigh controls.

Validation: 53 Rust tests pass, three opt-in tests are excluded from the default suite; the live Codex streaming/cancellation/owned-process-exit test passes separately. Two frontend state tests, six browser tests, four timing tests and the 13-check native scheduler acceptance pass. The release executable is built and running; the earlier 0.2.2 MSI has not been rebuilt for this scheduler change.
