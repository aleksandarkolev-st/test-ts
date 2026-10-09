# Learned local speculation gate

This is an experiment, disabled in release builds. The near-instant first-phrase
target is still unmet. Nemotron, signed-in Codex, Luna Fast, and the user's saved
160 ms speech chunks remain the answer path.

The gate uses a persistent CPU sentence encoder and a supervised three-class
head: background, unfinished request, and ready request. It contains no canned
answers, domain allowlists, or handwritten intent phrase rules. Generic input
limits, scheduling intervals, and confidence thresholds are control policies.
Training/evaluation examples are separate files, never production routing data.

Changed text is classified at most every 250 ms. A watch channel replaces pending
inputs rather than accumulating a queue. Predictions must match the current
text, floor, and classifier context. Early sending requires acoustic quiet,
stable text, and high request/readiness scores. There is at most one classifier
speculation per acoustic floor. Final transcript confirmation never waits for
the classifier. An already available, exact-input background prediction at 0.95
may suppress an answer request; uncertainty or changed final text falls through
to Luna immediately. Answer requests still supply exact selected code and conversation context.
Speculative answers remain hidden until final question/context validation.

The owned worker runs on CPU, with two inference threads, in a Windows process
job. Failure or timeout disables speculation for that session and emits a
numeric/status diagnostic. Stop cancels the worker; a failed classifier does not
suppress final inference. Unicode NDJSON explicitly uses UTF-8 on Windows.
Tokenizer truncation is disabled: oversized utterances abstain instead of losing
a trailing condition. The classifier's short context is distinct from the exact
context and code supplied to Luna.

## Evidence collected on October 9, 2026

The first NLI model probe ran in about 14 ms median / 20 ms p95 but missed 18 of
19 complete requests at a 0.5 joint intent/readiness threshold. It was not adopted.

The smaller encoder uses the pinned Apache-2.0
[all-MiniLM-L6-v2 model](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
(revision `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`), with a 23,046,789-byte
quantized ONNX asset. The downloader verifies each pinned asset's size and hash;
no remote executable model code or pickle is loaded.

The learned head was trained on 160 synthetic examples generated through
signed-in Luna Fast, low reasoning. Sixty separate examples selected
regularization; 80 further examples were held out and had no exact-text overlap
with either split. Model-generated labels are not human accuracy certification.

| Experiment | Measured result | Limitation |
| --- | --- | --- |
| Encoder-only head, 80 held-out examples | CPU median 1.60 ms, p95 2.22 ms | Excludes process startup/IPC and live audio load |
| Encoder-only head, threshold 0.9 | 4/25 ready requests selected; zero false early selections in this small set | Coverage too low; does not establish a safe error rate |
| Additional learned sequence features | 6/25 ready requests selected at 0.9; zero false early selections in that set | Selected none of 19 ready hand-labeled regression requests at that threshold; not promoted |
| Final-only native audio replay, four turns | First words 2121, 2044, 1798, 3074 ms from final speech end | Fixed recorded CUDA questions, remote-only capture; no microphone interruption certification |
| First gated audio replay | Classifier stopped after the first turn; no classifier-triggered early sends | UTF-8 worker defect invalidates a gating-benefit claim |
| First corrected audio attempt | Did not start capture: T24E390 output was unavailable | This attempt has no latency result |
| Healthy gated audio replay after T24E390 returned, four turns | First words 2190, 2552, 1807, 2676 ms; zero classifier-triggered early sends | Same binary, sources, speech settings, and waveforms as the matched final-only run; no demonstrated gating benefit |
| Matched final-only replay, four turns | First words 1982, 1840, 2155, 2095 ms | Small fixed replay set; infrastructure variation prevents attributing differences to the gate |
| Controlled native pause/condition probes | One learned early send per probe; output hidden during pause; added condition preserved exactly; first retained words 1312, 2782, and 1298 ms after simulated final speech end | Injected input excludes actual capture, VAD and ASR; selected cases are not aggregate accuracy evidence |
| Selected background speech probe | Locally ignored with zero answer-model turn starts | Excludes startup priming; one selected case is not a false-ignore accuracy certificate |
| Native CUDA transcript replays after the probes | First retained words 1647, 1797, and 2142 ms after simulated speech end | One fixed question per run, no ASR |

First word means receipt of the first alphanumeric character in the retained
answer after protocol decoding and question/context gating. It is not sentence
completion or an inaccessible server-side generation timestamp. Renderer timing
is separate.

The pause probe combines two generated public examples to exercise an actual
high-confidence early send. It is explicitly a controlled safety probe. Twenty
fresh generated pause pairs also exist, but none individually qualified at the
conservative threshold with the encoder-only head. No threshold was lowered to
force those pairs through.

All 112 active Rust library tests passed (14 live/integration tests ignored).
The worker's black-box UTF-8/oversize/continued-operation regression passed under
an explicitly forced Windows `cp1252` I/O environment. The final scheduler also
re-submits a finalized request when an earlier speculative no-reply job was
cancelled, rather than treating that early verdict as final. A further native
probe waited until the early model turn had actually completed before appending
the condition; its output still remained hidden. This used a deliberately long
simulated quiet period without a finalized transcript and does not certify real
ASR/VAD pause behavior.

The original [compact numeric evidence](evidence/intent-gate-v24.json) records
the earlier probes, including the failed worker run and unavailable-output attempt.
The [matched audio and continuation evidence](evidence/intent-gate-v27.json)
includes the healthy worker comparison, failed adaptive run, and corrected
six-turn continuation (three fixed replays followed by three adaptive questions).
That run retained every recognized question but included an incorrect concrete
counterexample; model grades are provisional and are recorded without claiming
full technical correctness.

A further training experiment combined 280 synthetic examples with explicit
assistant label review and a separate 90-example validation split. The review
distinguishes incomplete speech from a complete request that needs clarification,
and deferring an assistant reply from an operational waiting requirement. This
is supervised annotation, not live phrase routing or human certification. The
revised encoder-only head still selects just 1 of 19 complete requests in the
regression suite at 0.9; neither revised head was promoted.

A fresh adaptive CUDA audio interview exposed a separate turn-identity defect:
speech resumed before the first ASR final of a new turn arrived, and the detector
restored a confirmed question from the previous turn. Restoration now requires
the confirmed question's acoustic floor to match. A regression covers this event
ordering. Replaying the three recorded turns confirmed the fix through the
previously failing question; subsequent questions continue adaptively.

An isolated audio replay later exposed a late-tail defect. The detector could
reconfirm an earlier prefix while new words remained partial, then drop that
prefix when the tail finalized beyond the clause-gap interval. Confirmation
now waits for a nonempty partial to finalize, and a final from audio already
inside the observed clause retains its confirmed prefix despite ASR delay.
Separate regressions cover both cases. These are acoustic identity/finalization
checks, without phrase or domain rules.

The corrected late-tail audio replay retained the full recognized question and
produced a first word at 2790 ms, but the answer was incorrect. An exact injected
public question plus the examiner's generated clarification produced a valid
counter trace for the wrong requested finalizer, graded incomplete, at 1589 ms
from simulated speech end. It excludes capture, VAD, and ASR. The general
instruction to check a small concrete execution trace does not establish solved
technical correctness. No interview answer, CUDA implementation, or reference
trace was added to production routing or prompts.

The [latest numeric evidence](evidence/intent-gate-v30.json) includes these
failures and corrected transcript checks. Regenerate it from local terminal
artifacts with `node scripts/summarize-intent-gate.mjs`.

Final-only mode can still begin on an earlier finalized acoustic clause. It
means no partial-transcript speculation, not waiting for an inaccessible semantic
end of the entire interview question. First-word measurements refer to the last
speech endpoint and retained final answer version; old provisional deltas are
not interpreted as parsing delay.

Raw local evidence is under `artifacts/intent-classifier/` and
`artifacts/native-interview/luna-local-intent-*/`. Those directories are ignored
by Git. The idle production app was rebuilt and refreshed with the transcript
fixes and general reasoning instruction; all saved settings were preserved.
The classifier remains disabled in release builds.

## Reproduction

The current development worker uses the workspace's existing Python 3.11 runtime
at `.local/gaze-runtime/Scripts/python.exe`; pinned classifier dependencies are
listed in `scripts/intent-classifier-requirements.txt`. Tokenizers was installed
into `.local/intent-deps`, passed through `PYTHONPATH`. This is not yet a packaged
classifier runtime.

Download the data-only model with `python scripts/setup-intent-classifier.py
--encoder`. Generate separate training, validation, and held-out files using
`scripts/generate-intent-data.mjs` (signed-in Luna Fast; no API key). Train with
`scripts/train-intent-classifier.py`, evaluate with
`scripts/evaluate-intent-classifier.py`, and run
`scripts/test-intent-worker.py` using that Python runtime.

Debug native acceptance modes are `COPILOT_INTENT_MODE=early` and `final`.
`COPILOT_ACCEPTANCE_INPUT_ONLY=1` explicitly disables device capture for injected
transcript tests; the harness rejects using it with real-audio measurement.
Real-audio comparisons require the chosen monitor output to be present, the same
native binary/model/profile/source hashes, and matched public waveforms. Tests
must retain exact final questions and count actual speculation/restart evidence.
For a continuation regression, `COPILOT_NATIVE_INTERVIEW_REPLAY_PREFIX_ROUNDS`
replays only the declared prefix from `COPILOT_NATIVE_INTERVIEW_REPLAY_DIR`;
remaining questions are generated adaptively from the actual answers. The
artifact labels that mixed scope explicitly.

Remaining work: improve readiness coverage without sacrificing precision,
test genuine pause/condition
and microphone interruption cases, and verify useful phrases and code through
fresh adaptive deep interviews. Current evidence does not meet 200–400 ms or
p95 below 800 ms.
