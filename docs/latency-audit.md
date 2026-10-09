# Live response latency audit

The largest remaining delays occur before the first retained word. Six fresh adaptive synthetic-audio questions on signed-in Luna low/Fast took 2,207â€“3,388 ms after speech ended (median 2,680 ms). This remote-only acceptance run excludes room microphone interruptions. It does not establish broad p95 or hard-interview correctness.

The [recorded stage audit](evidence/luna-fast-latency-v18.json) separates first-word receipt from answer completion. Speculative stages overlap; these medians must not be added together.

| Stage | Observed time | Implication |
| --- | --- | --- |
| Speech end to final transcript | 618â€“883 ms, median 736 | Final recognition consumes most of an 800 ms budget before a confirmed answer can be displayed. |
| Final transcript to confirmation | 2â€“39 ms | The 40 ms runtime tick is a small contributor in this run. The 200 ms acoustic fence overlaps finalization rather than adding 200 ms here. |
| Confirmation to replacement input, retried rounds | 403â€“405 ms | The 400 ms unconsumed-refinement wait is visible. Removing it blindly previously made some replies slower; obsolete work must be retired safely. |
| Latest input sent to consumption notification | 54â€“711 ms | An acknowledgement is not immediate application of the input. This interval also includes transport/service event timing. |
| Latest input consumed to retained first word | 1,243â€“1,663 ms | Largest observed interval; includes inference, transport, framing and local delivery. It does not isolate server compute. |
| First word to render acknowledgement | 8â€“13 ms | UI rendering is a low priority for this latency target. |
| Foreground slot/prepared thread waits | 0 ms | No measured pool starvation in these six samples. |
| Interrupt terminal cleanup | 1â€“2 ms | Not the cause of these second-scale delays. Saturated output cleanup already has a regression fix. |

## Weaknesses and current action

1. **Repeated provisional generation and queued corrections.** The default driver used 0â€“6 steers and 0â€“5 follow-ups per question. Each obsolete generation can delay the final frame. Two four-waveform comparisons in opposite orders found that holding question-only refinements until confirmation made six of eight pairs faster: descriptive median 2,837.5 ms versus 2,027.5 ms. Different generated contexts and cloud calls prevent a causal claim. Separate text probes regressed, and every native sample still exceeded 800 ms. The experimental policy remains disabled in release. See [cross-order evidence](evidence/luna-refinement-comparison-v17.json).

2. **Retracted drafts fed back as reference context.** A failing runtime regression showed that resuming the same unfinished question cleared its buffer but retained its visible draft in meeting context. That could create a spurious context correction. Both continuation paths now forget only the resumed job's retracted suggestion. Earlier answers and exact displayed code for other questions remain available. The fix passed 102 library tests and the release build, and is in the workspace app. A causal latency improvement has not been demonstrated.

3. **Endpoint delay versus premature cuts.** Nemotron currently uses 510 ms endpoint history with 160 ms chunks. Final transcript receipt takes longer than that configured endpoint alone. Reducing either setting needs matched audio and clause-retention evidence: prior 80 ms chunk tests did not show a consistent first-output improvement. A learned endpoint classifier could help, but the evaluated audio-only classifier prematurely accepted internal pauses or rejected true ends. Adding another model request on the critical path would itself add latency. Reply intent is already classified by signed-in Luna in the same inference as the answer, without domain phrase routing.

4. **Microphone activity splits remote questions.** Two normal capture runs lost earlier clauses after microphone speech-start events interrupted the remote floor. This damages useful speculation and can trigger replacement requests. The cause of microphone activity is unproven. Remote-only capture isolates experiments; production still captures both channels. A change here must preserve genuine interruptions and avoid merging different speakers' turns.

5. **Growing exact answer history.** Selected meeting excerpts have budgets, but the two recent suggestions, retained complete implementation and visible unfinished suggestion can be much larger. Long code can increase input size and exhaust the reusable history budget, which suppresses intermediate refinements. This is a source-level risk, not measured starvation in the six-round run. Any reduction must preserve the exact code and constraints needed for follow-ups rather than silently truncate them.

6. **Repeated decoding and publishing.** The JSON reply decoder reparses accumulated text, and runtime publication clones the current snapshot on updates. These can become more expensive for long streamed code. They are lower-priority candidates: current rendering is about 10 ms, and no CPU profile has attributed the much larger post-consumption interval to them.

The assistant still fails some difficult reasoning questions on Luna low/Fast, including the final release-sequence question in this run. Faster first words alone would not satisfy the goal. The [independent review](evidence/luna-fast-review-v18.json) records the technical limitations. No scenario-specific answers or CUDA keyword fixes were added.

Regenerate a stage audit from another recorded interview with:

```powershell
node scripts/summarize-latency-stages.mjs artifacts/native-interview/<run>
```
