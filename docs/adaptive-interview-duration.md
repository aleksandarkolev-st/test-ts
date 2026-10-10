# Adaptive elapsed-time interview probes

Build the native app and examiner with `cargo build --features acceptance --bin
meeting-copilot --example adaptive-interview` from `src-tauri`. Run
`scripts/native-signed-interview.mjs` with `COPILOT_NATIVE_INTERVIEW_MINUTES=60`,
`COPILOT_NATIVE_INTERVIEW_AUDIO=1` and a fresh output directory. Supply a domain
brief in `COPILOT_NATIVE_INTERVIEW_BRIEF`; omit scenario and replay options to
generate a fresh opening and private examiner rubric. Each next question is
generated from the actual candidate answer and interview history. The assistant
receives public questions and conversation, never the private examiner rubric.

Each new native run records a random run identifier and supplies it with the
brief to scenario generation. Every grading request also supplies the examiner
with the original brief, elapsed time and requested duration. This preserves the
scope of a broad interview after its first opening and encourages fresh problem
families when a line of reasoning is established, while retaining deeper
follow-ups from actual answers. These fields are examiner-only data; they add no
topic routing or question bank to the live assistant. Repeated errors should be
recorded before moving to another problem family, rather than spending the whole
interview restating a failed exercise. A run identifier is a
variation prompt, not proof that questions are unique or uniformly random.
Inspect the recorded questions to verify diversity. Examiner reviews describe
the actual current and next topics using free-form labels, rather than a fixed
topic vocabulary; these descriptions also require review before coverage claims.

The duration uses a monotonic clock starting after setup and the introduction.
It includes spoken questions, candidate responses and examiner grading, and
finishes the active round after reaching the requested duration. It adds no
filler sleep. A safety round cap exhausted before the elapsed duration fails
instead of claiming an hour-long interview. Timed runs require adaptive review.
Run audio probes sequentially on the same output/GPU; concurrent corpus capture
would interfere with their ASR measurements.

The native journal records actual first-word receipt after speech end, including
ASR, and receipt after the latest submitted model input. It records rendering
separately. Changed current-turn event slices avoid copying the growing complete
event history on every timing poll. Raw recognized clauses and ASR finalization
markers remain available for diagnosis; their preservation does not establish
speech recognition accuracy.

The audit also reports when a changed transcript first matched the eventual
recognized question, and when its last uninterrupted matching suffix began.
Matching preserves case and code operators and normalizes whitespace only.
Observations from other speech floors are excluded. The interval from that
stable text to the latest model request identifies possible early-send lead
time retrospectively; it does not establish semantic completeness, classifier
confidence, or an achievable latency reduction. Missing observations stay
unknown, and overlaps before speech end remain negative.

`node scripts/summarize-interview-duration.mjs DIRECTORY` verifies terminal
duration and first-word identities and writes `duration-audit.json` plus
`round-metrics.csv`. These record both first-word clocks, ASR finalization,
input consumption, rendering, separate answer completion, restart/steer counts,
and model-grade denominators including pending reviews. Normalized lexical ASR
word error compares the recognized text with the synthesized source; harmless
number or code spellings can still count as edits. Interruption coverage is
reported explicitly rather than inferred from sequential questions. Add
`--snapshot` for read-only progress while a run is active. Sample percentiles and
model examiner grades are not population latency or independent correctness
certification. When an `independent-review.json` exists, every finding's question
and answer hashes must match the journal; selective findings remain separate
from the full model-grade rate. Native failures, routing timeouts and examiner attempts remain
in the journal. At most one configured retry applies to an examiner answer or
workspace-routing timeout; this wrapper never retries candidate generation.

## Interrupted v62 runs

The [recorded evidence](evidence/interview-duration-v62.json) preserves both
requested 60-minute runs. Signed-in Codex's usage limit stopped CUDA after 58
completed and graded rounds and 35.45 measured minutes. The subsequent algorithms
run failed during scenario generation and recorded no rounds. Neither run
establishes an hour-long interview. Existing-mode Luna Fast/low was measured;
this is not a result for the experimental learned classifier.

CUDA retained first-word latency was 2,378 ms median, 3,916 ms sample p95 and
5,115 ms maximum from speech end, including ASR. From the latest model input sent,
the median was 1,482 ms and sample p95 2,958 ms. Rendering after first word was
8 ms median; separate whole-answer completion was 4,096 ms median. Stage medians
cannot be added because speculative work overlaps.

The model examiner graded 38 correct, eight incorrect and 12 incomplete (65.5%
graded correct). Selective independent review recorded four problematic rounds,
including a failure missed by the examiner; it does not certify the remaining
answers. All recognized clauses reached confirmed questions, but lexical ASR
comparison still recorded 388 edits across 2,329 source words (16.66% normalized
word error, including potentially harmless number/code spellings). There were
19 refinement restarts across 19 rounds, 129 steering operations and 109
follow-up operations in retained pipeline traces. No completed request was
ignored. Sequential remote-only audio did not test live microphone interruption
handling. Exact round questions, answers, transcripts, audio and model reviews
are retained with the JSON/CSV exports in `artifacts/native-interview`.

These results do not meet the requested sub-800 ms p95 or establish correctness
through a full hour. No model profile or runtime phrase routing was promoted
from this interview.
