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

## Further readiness experiments

The [readiness and matched audio evidence](evidence/intent-gate-v34.json)
records joint-attention and small neural-head alternatives, neither promoted.
The joint head selected no ready requests at 0.8 on a freshly generated,
assistant-reviewed 60-case set. The neural alternative made high-confidence
false early classifications. This set was subsequently reused for diagnostics;
it is not a fresh test set for later head selection.

Training texts had a punctuation bias: unfinished requests lacked terminal
punctuation, while most complete requests had it. Offline augmentation adds
unpunctuated variants without changing live transcript text, code, or identifiers.
On the same 90-case ASR-style validation set, loss fell from 1.68 for the original
head to 0.73 with 340 original examples and 518 correlated training variants.
Coverage and precision remain inadequate: at 0.8, three of 16 selected validation
requests were false early classifications; at 0.9, 33 of 36 ready requests were
missed. Synthetic labels were reviewed by the assistant, not certified by humans.
The generator also failed its requested long-speech lengths: the additional
60 examples averaged 25 words, with none reaching 50 words. New generator
metadata records actual length compliance rather than assuming prompt compliance.

Classifier context now excludes its current acoustic floor's own answer draft.
It retains earlier answers after the current answer completes and includes
other-speaker corrections on the current floor. Exact code context supplied to
Luna remains intact. All 114 active Rust library tests pass, with 14 ignored.

A lower-threshold audio run with the original head produced no early sends.
The extended ASR-trained head, at 0.8 with corrected context, triggered twice in
four fixed remote-audio turns. One trigger was the incomplete fragment
"what exact". Final recognized questions retained every clause. A matched
final-only run used the same binary, sources, waveforms, monitor and 160 ms
Nemotron chunks:

| Mode | First word after final speech end, ms | Mean, ms |
| --- | --- | --- |
| Learned gate | 1751, 1806, 1947, 2308 | 1953 |
| Finalized transcripts only | 2003, 1903, 1792, 1927 | 1906 |

These measurements include ASR and refer to the retained answer version. They
show no demonstrated improvement and cannot establish a population p95. They
exclude real microphone interruptions and are fixed replays, not fresh adaptive
interviews. The original local profile was restored and the gate remains disabled
in release. No semantic word lists, domain routing, canned replies, or interview
solutions were added to the live assistant. Regenerate this evidence with
`node scripts/summarize-intent-readiness.mjs`.

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
`COPILOT_INTENT_READY_THRESHOLD` controls the debug readiness threshold, default
0.9. Invalid configuration disables early sending without delaying final inference.
Offline head alternatives are `train-intent-classifier.py --joint` and
`train-intent-mlp.py`; `augment-intent-data.py` produces ASR-style training
variants. None is automatically promoted to the runtime profile.
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

## Encoder fine-tuning and coalesced updates

`train-intent-encoder.py` now fine-tunes the six-layer encoder with a three-class
head, using pinned safetensors assets and no downloaded executable model code.
Training and inference share `intent_tokens.py`. Current utterance tokens,
including code operators and identifiers, take priority over history; inputs
above 254 current tokens abstain instead of silently losing a condition. History
uses the remaining sequence budget. The worker verifies graph and tokenizer
identities and uses two CPU inference threads.

The trainer samples one ASR variant per source case per epoch, selects an epoch
and temperature on validation data, and exports FP32 and INT8 profiles. FP32
export must match native logits within 0.001 with no changed validation labels.
For the paired-data model, the observed maximum FP32 difference was 0.00000525.
INT8 changed three validation decisions, reducing accuracy from 86.7% to 83.3%.
FP32 validation inference had a 1.93 ms median and 3.54 ms sample p95, compared
with 1.04 ms and 1.76 ms for INT8. These CPU measurements are not end-to-end
speech or answer latency.

The added training data contain 90 correlated variants from 30 matched episodes.
Review corrected two complete requests incorrectly labeled unfinished and removed
context from all variants after finding that context presence nearly determined
the generated class. Original contexts remain in audit metadata. This is offline
data review, not live text normalization or semantic routing. Neither these labels
nor validation accuracy constitute human certification. A fresh 30-case long set
was reviewed before testing the initial fine-tuned model; it became a reused
diagnostic for subsequent models. Long-form generation now checks actual word
counts, and augmentation rejects contradictory labels for identical transformed
text and context.

Lower validation loss did not make background suppression safe: a complete
imperative was still assigned background probability above 0.95. Consequently,
background suppression is disabled by default, even in learned experiments.
`COPILOT_INTENT_BACKGROUND_IGNORE=1` separately enables that unpromoted debug
experiment. Finalized inference never waits for the CPU classifier.

The scheduler can now deliver an exact updated request to an existing speculative
job without allocating another job or foreground slot. The gate continues
classifying changed input every 250 ms after the first speculative send, but only
a current, high-confidence readiness prediction authorizes a speculative update.
There is still at most one initial speculative send per acoustic floor. A changed
request clears stale answer text and timing; wrong-floor and already-confirmed
requests cannot be rewritten this way. Final confirmation remains authoritative.

Forwarding every partial unconditionally was rejected. Its four replay turns
produced first words at 1442, 1381, 2515 and 3010 ms after speech end; longer
questions caused many updates and multiple model follow-ups. Readiness-gated
updates reduced that churn but did not demonstrate the target: the corresponding
four-turn run measured 2706, 1878, 1755 and 2050 ms. These runs used different
native builds and are diagnostic experiments, not a controlled causal comparison.
The unconditional trial's top-level acoustic refinement flag reflected runtime;
its nested speech configuration incorrectly recorded the flag as false. The
harness now records the automatic learned-mode policy consistently; the original
artifact is preserved.

For offline fine-tuning, download assets using `setup-intent-classifier.py
--training`, install the separate pinned `intent-training-requirements.txt`
dependencies (CPU Torch index is listed there), and run:

```text
python scripts/train-intent-encoder.py --train TRAIN.json --validation VALIDATION.json --output .local/intent-encoder/EXPERIMENT
```

Evaluate either generated profile with `evaluate-intent-classifier.py --profile`.
No profile is automatically installed as the runtime profile. All 116 active
Rust library tests and the three shared-token boundary tests pass; the FP32 worker
also passes the UTF-8, oversized-input abstention, and continued-worker contract.
The classifier remains disabled in release builds. No canned responses, semantic
keyword rules, CUDA-specific routing, or interview answers were added to inference.

The [fine-tuning and native evidence](evidence/intent-gate-v44.json) also records
a fresh six-turn adaptive interview, followed by a final-only replay of its exact
public questions and saved waveforms. Both use the same native binary, sources,
T24E390 monitor output, and 160 ms Nemotron chunks. The early run additionally
enables acoustic refinement; the final-only replay's questions cannot adapt to
its different answers.

| Mode | First word after speech end, ms | Mean, ms |
| --- | --- | --- |
| Learned FP32 gate, fresh adaptive | 2106, 2592, 1341, 2074, 2843, 2789 | 2291 |
| Final-only, same public audio replay | 2420, 1649, 1917, 2148, 1812, 1715 | 1944 |

This small comparison demonstrates no latency advantage and no population p95.
Early-run ASR finalization took 570–823 ms. All recognized clauses were retained,
but recognition did not preserve every intended numerical fact: a completion
ratio became an ambiguous string of numbers, and Luna repeated it as a large
count. This is an accuracy failure, not a successful exact-context proof.

The final early-run answer also left the exact payload-visibility question
unsettled. A producer fence orders that thread's accesses; the documented legacy
atomics use relaxed ordering. The answer needs a valid consumer synchronization
argument, separately from liveness. See NVIDIA's [memory fence documentation](https://docs.nvidia.com/cuda/archive/12.9.1/cuda-c-programming-guide/index.html#memory-fence-functions)
and [atomic ordering documentation](https://docs.nvidia.com/cuda/archive/12.9.1/cuda-c-programming-guide/index.html#atomic-functions).
The model examiner marked that answer incomplete. This experiment excludes
microphone interruptions, physical CUDA execution, and human certification.

The original profile was restored after the early run. Reproduce the summarized
evidence from the preserved local artifacts with
`node scripts/summarize-intent-finetuning.mjs`. The goal remains unmet.

The next experiment counts the age of an already-pending Codex steer against
the 400 ms final-consumption budget, instead of starting the entire budget again
at confirmation. It is acceptance/debug-only (`COPILOT_AGE_FINAL_WAIT=1`). The
transport reader records the current turn's exact input fingerprint before a
full output queue can delay delivery of its consumption event. An expired age
budget cannot restart work whose matching consumption is already known. The
existing terminal cleanup and single fresh retry still apply. Release defaults
retain the original wait policy.

Two six-turn runs replayed the same public audio on the same build, classifier,
T24E390 output and 160 ms Nemotron configuration. Model grading was skipped
between these fixed replay turns, reducing extra calls and inter-turn gaps.
Adaptive interviews still require their examiner; the harness rejects skipping
review when any question must adapt.

| Pending-wait policy | First word after speech end, ms | Mean, ms |
| --- | --- | --- |
| Original budget | 2022, 1950, 2138, 1621, 2628, 3997 | 2393 |
| Age-aware budget | 1879, 1652, 2133, 1414, 2140, 2126 | 1891 |

These small samples do not establish a causal 502 ms gain. Most pending inputs
were newly sent at confirmation; some corresponding turns followed different
completion paths, and recognition and cloud timing varied. One experimental
turn recorded a 440 ms pending age and zero remaining wait budget. Recognition
also lost an intended thread-count detail in the baseline, despite retaining
all *recognized* clauses. No population p95 or general accuracy claim follows.

A fresh 12-round adaptive audio interview then drilled from an underspecified
deployment symptom into complete reduction code, 64-bit indexing, shared scratch,
multiple consumers, event-handle generations and numerical correctness. Its
first-word median was **2255 ms**, range **1614–3551 ms**. ASR finalization had
a 788 ms median; the interval from latest input consumption to retained first
word had a 1176 ms median. That latter interval includes cloud inference,
transport, decoding and delivery. Rendering added 5–12 ms. Stages overlap and
their medians must not be summed as independent costs.

New opt-in acceptance diagnostics (`COPILOT_TRACE_PROVISIONAL=1`) record up to
256 Unicode characters per speculative revision and raw ASR segment boundaries.
They do not authorize display or prefix reuse. The offline audit observed 37
different-question prefixes before speech ended and zero longest bounded
prefixes per revision that literally matched the retained answer. Shorter
cumulative snapshots were not tested for literal matching. Nonmatch does not prove semantic
invalidity, and matching question text would not prove matching context. Host
text-update intervals reached 583 ms; these are polling observations, not proof
that a person could speak continuously. Raw segment timestamps refer to submitted
audio chunks, not aligned word times.

Independent review found substantive failures. The event counterexample claimed
premature overwrite even though both waited-on later records remained ordered
after the corresponding earlier reads on the same consumer streams. CUDA waits
capture event state at the call and later records do not alter that wait; see
NVIDIA's [event-record semantics](https://docs.nvidia.com/cuda/archive/12.9.1/cuda-runtime-api/group__CUDART__EVENT.html).
The numerical answer also substituted sequential additions for the actual
shared-memory reduction tree. For its three-element input, the supplied tree
combines lanes 0 and 2 before lane 1 and produces one, not zero.

Both complete code answers were independently compiled unchanged with NVIDIA
NVCC 12.9.86, C++17 and `sm_80`: round 2 linked an executable; round 3 produced
an object file. Source and output hashes and the verified official compiler
archive provenance are included in the evidence. No CUDA device execution was
performed, and these checks do not cover later illustrative usage snippets.

The investigation also found a structural context bug: every closed code fence
could replace the single preserved implementation, so a usage snippet could
discard earlier definitions from a fresh context. Code-bearing answers now have
a chronological 32,000-character archive with whole-entry eviction; the latest
two answers and visible unfinished answer remain included without duplicates.
A single individually accepted answer can exceed the archive budget with its
question. Closed fences identify text worth preserving, not semantic completeness
or which code is active. The model must resolve versions using conversation and
later constraints. Tests cover usage snippets after many follow-ups, ordering
of late completions, bounds, deduplication and reset. This adds relevant context
and may increase prompt size; it is not a demonstrated latency improvement.

Generic instructions now require tracing the actual supplied code, checking
whether a requested counterexample is possible, and distinguishing illustrative
usage from complete implementations. There are no domain-specific diagnoses,
semantic keyword routes, cached interview answers or canned response prefixes.
The exact public transcript replay separately checks the revised context and
instructions without audio or ASR. Its answers differ from the original audio
run, so it cannot be used as an audio latency comparison or adaptive certification.

That replay still failed important questions with exact source text: its
explanation misstated the block count despite a correct ceiling calculation;
it repeated the impossible same-consumer-stream schedule; and it again traced
the wrong reduction tree despite retained definitions. The examiner incorrectly
marked one impossible schedule correct. Model grades are therefore stored
separately from independent findings. A separate exact replay of the earlier
named-actor counterexample checks the generic claim instruction, without
including any expected answer in the candidate's input.

The named-actor case failed at low reasoning: Luna repeatedly made B the finalizer
and then wrongly declared A's finalization impossible. With the same question,
binary and runtime sources, Luna Fast at high reasoning gave a correct trace,
but its first word took **5767 ms**, compared with **1462 ms** at low. Both runs
used exact transcript injection and exclude ASR. This single diagnostic shows
a relevant quality/latency tradeoff, not general high-reasoning accuracy. The
harness now accepts `COPILOT_NATIVE_ANSWER_EFFORT=low|medium|high` for isolated
comparisons; its default and the live app's saved setting remain low.

The [experiment evidence](evidence/prefix-experiment-v48.json) is reproduced with
`node scripts/summarize-prefix-experiment.mjs`; per-run stage and prefix audits
use `summarize-latency-stages.mjs DIRECTORY` and
`analyze-provisional-prefixes.mjs DIRECTORY`. The classifier profile was restored
and remains disabled in release. Real microphone interruptions, CUDA execution,
near-instant response timing and general deep-interview correctness remain
unverified or unmet.
