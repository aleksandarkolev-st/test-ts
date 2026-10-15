# Answer runtime and latency

Implementation notes and historical measurements. For setup and daily use, see [the README](../README.md). These measurements do not establish live meeting accuracy or a latency guarantee.

The current signed-in Codex path starts speculative inference on remote transcript candidates and lets the model classify reply intent in the same inference. Three prepared threads support at most two active answers. Growing questions and changed context are coalesced; output carries exact question/context identity and is shown only for the confirmed current frame. Superseded output is retracted, and obsolete-turn replacement requires terminal cleanup. Exact earlier code remains available for deeper follow-ups. See [adaptive interview verification](adaptive-interview.md) and the [latency audit](latency-audit.md).

Historical refill results remain in [the refill benchmark](refill-benchmark.md); the earlier scheduler and its five-sample effort trials remain in [speculative answering](speculative-answering.md). The current report distinguishes provisional first text from text retained for the final question and retains slow trials. These controlled fact-recall checks do not establish general meeting accuracy or a sub-second service guarantee.

The earlier 100-trial release run recalled its controlled fact in 100/100 answers. Audio median confirmed-answer visibility was 1945 ms at 80 ms chunks and 2709 ms at 160 ms, with a retained 54.9-second outlier. Forty audio questions used 51 jobs with 11 cancellations. See [the full results, limits and raw evidence](realtime-optimization.md#final-100-sample-release-results).

### Reducing first-answer delay

Meeting startup prepares three ephemeral threads for the selected model, speed and effort. Confirmation requires a final transcript and 200 ms of silence. Retrieval budgets relevant memory and conversation separately from exact suggested code and explicit attachments. Partial question refinements wait for stability and a minimum cadence; changed selected context has a bounded submission deadline. Final confirmation supplies the latest question and context. Timing records the first retained answer-word character separately from completion and rendering. Stop clears all work and closes the persistent authenticated broker. The sub-800 ms target remains unmet in current live evidence.


