# Recorded interview findings, October 11

All fresh recordings used gpt-6.1-sol with low reasoning, T24E390 playback output, 160 ms Nemotron chunks and microphone capture disabled. Runtime scheduling remains independent of topic, expected answer and benchmark identity. This round records outcomes; no recorded answer was repaired to improve its score. The architecture candidate remains in its separate checkout.

Three actual elapsed-hour interviews completed. The [full review-input audit](evidence/full-independent-review-audit-v71.json) verifies immutable source questions, recognized wording, public context, untouched answers and independently generated judgments across **64 cohorts and 338 reviews, with none pending**. These include the three hours, twelve attached-test recordings, pressure jobs, 24 policy controls and 24 architecture controls. The [requirement audit](evidence/measured-goal-scope-audit-v71.json) maps every attached numbered requirement to its actual recordings and findings; execution coverage does not imply every expected product behavior succeeded.

| Interview | Duration | Correct / all rows | Incorrect | Incomplete | Retained words | Observed-word median | All-row first-word p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| General | 61.07 min | 43 / 55 | 0 | 12 | 55 / 55 | 8.92 s | 36.22 s |
| Systems | 60.13 min | 35 / 52 | 0 | 17 | 51 / 52 | 9.76 s | 39.36 s |
| DSA | 61.45 min | 30 / 49 | 4 | 15 | 48 / 49 | 12.30 s | 73.95 s |

Accuracy judgments are provisional model reviews, not population estimates. First-word delivery does not require a correct or completed answer. The [all-row latency report](evidence/all-trial-hour-word-latency-v71.json) ranks missing deliveries after observed deliveries without inventing a timeout latency. These are dependent synthetic samples. Systems had one unanswered timed-out row; DSA had one spoken “Why?” with no native job.

Actual questions include short context-dependent follow-ups, incomplete restatements, unrelated switches and false premises. The [general topic review](evidence/completed-general-topic-coverage-v71.json) records its source questions; the [systems](evidence/universal-question-coverage-systems-v71.json) and [DSA](evidence/universal-question-coverage-algorithms-v71.json) records expose every question for inspection. Recording a requested style does not establish that the answer handled it correctly.

## Why the long tails occur

The [78.6-second DSA response](evidence/algorithms-79-second-tail-decomposition-v71.json) spent 35.16 seconds between final confirmation and final-input submission, then 38.56 seconds before matching reader receipt, 70 ms before consumer handling, 4.23 seconds before retained decoded text and 7 ms before native visibility. The pre-submission wait is application scheduling. The subsequent wait combines service, transport and preceding reader work; isolated model computation is unavailable. The source permits 120 seconds per attempt.

The candidate coalesces question revisions locally and retires obsolete work before submitting a replacement, preserving a stale-work bound on every attempt. One [matched systems pair](evidence/architecture-systems-tail-pair-v71.json) reduced confirmation-to-send from 19.17 seconds to 405 ms and physical first-word time from 48.30 to 10.61 seconds. However, another [candidate trial exhausted its replacement budget](evidence/architecture-replacement-exhaustion-v71.json) and produced no word. The [assessed 24-trial comparison](evidence/matched-architecture-controls-assessed-v71.json) records twelve correct baseline answers, versus eleven correct and one incomplete candidate answer. Observed-word median fell from 14.01 to 10.98 seconds, but the candidate has no finite all-trial p95: eleven delivered words out of twelve cannot cover 95% of that sample. No limit was changed to accommodate the failed question. Deliberate case selection, dependent repeats and differing ASR wording prevent a population or universal improvement claim.

Prompt excerpts have individual budgets, while exact code and previous answers are appended. The [code-retention checks](evidence/recorded-substantive-checks-v71.json) also reveal a cost of bounded history: two older implementations were absent from selected context when referenced after twenty intervening turns. The dedicated memory probe requested the missing source rather than reproducing the original code. This does not demonstrate the strict retention behavior, even though the clarification itself was judged appropriate.

The [copied-decoder benchmark](evidence/decoder-prefix-benchmark-v71.json) executed 54 workloads and preserved every answer exactly; its maximum total synchronous decoding time was 1.43 seconds. It does not explain the tens of seconds before submission or isolate all provider framing and reader delays.

## Attached ten tests

Execution coverage and successful behavior are recorded separately. The [full verified review audit](evidence/full-independent-review-audit-v71.json) binds all rows below. The [attached requirement mapping](evidence/attached-requirement-evidence-v71.json) preserves supported, qualified, unverified and contradicted findings. Manual checks are source-specific evaluation evidence; they never select production behavior.

| Requirement | Recorded observation | Remaining qualification or failure |
| --- | --- | --- |
| Deep warp follow-ups | Five dependent answers were judged correct. The two requested reduction implementations compiled unchanged. | A separate illustrative kernel-plus-host-launch fence failed standalone compilation. [Manual collective checks](evidence/warp-source-bound-manual-checks-v71.json) and [compiler outcomes](evidence/recorded-substantive-checks-v71.json) remain separate from NVIDIA hardware execution, which was unavailable. |
| False barrier premise | The answer rejected the safety guarantee. | It assumed a one-dimensional block; the spoken source did not specify dimensions. The [manual dimensional qualification](evidence/exact-probe-source-checks-v71.json) is retained. |
| Never-recorded event | The answer rejected retroactive synchronization and handled the recognized event-name change. | [API-semantic review](evidence/exact-probe-source-checks-v71.json), without GPU execution. |
| FP32 association | Actual per-operation binary32 evaluation produced 1 and positive 0. | [Arithmetic check](evidence/exact-probe-source-checks-v71.json) assumes the stated rounding and no reassociation. |
| Late no-atomics reversal | Both final histogram code blocks compiled unchanged; the exact-pause answer was judged correct, the other unverified. | Compilation does not prove execution correctness or absence of every obsolete intermediate display. |
| Mid-question pause | A 30.395-second voiced span had an exact 1,500 ms inserted pause near its midpoint; the final answer retained the overflow/reject condition. | [Physical proof](evidence/midpoint-pause-physical-proof-v71.json) covers this recorded delivery, not all pause patterns. |
| Exact launch numbers | Recognized 10,000 elements and 192 threads; the answer gave 53 blocks. | [Source-bound arithmetic](evidence/exact-probe-source-checks-v71.json) covers this sample. |
| Unrelated streaming switch | Database answer judged correct; old CUDA display remained for three milliseconds after confirmation. | [Observed switch](evidence/switch-prior-question-display-v71.json) does not certify every display transition. |
| Memory after 20+ turns | The dedicated probe referenced round 1 at round 22, with twenty intervening turns. | Original code absent from selected context and not reproduced; the public reference was also truncated by the interviewer. [Retention check](evidence/recorded-substantive-checks-v71.json). |
| Continuous pressure | Actual 30.224-minute playback, 158 source utterances, 91 native jobs. | [Pressure measurements](evidence/continuous-pressure-measurements-v71.json) and [display finding](evidence/pressure-prior-question-display-v71.json) expose missing answers, retained prior text and resource growth; a no-degradation/no-leak result is not established. |

The pressure reviews recorded 32 correct, 56 incomplete and three unverified native-job answers. Those 91 jobs are not 158 separate questions: source utterances can split or merge. Global lexical alignment found thirty substitutions and no deletions among 3,557 source words; that does not certify preserved semantics. Sixty-eight sources had no retained visible word. Physical source/job pairs had a 41.82-second observed-word p95, compared with 10.54 seconds measured from native job endpoints; those denominators and endpoints differ.

The longest individually recorded prior-question paint interval held an old vehicle-acceleration answer for 51.577 seconds after confirmation of a new sliding-median/exact-sum request. The scheduler's existing completed-answer fallback retains text while the new buffer is empty. This is distinct from newly generated stale tokens, and remains unchanged by the tested candidate. Memory and latency drift remain descriptive; resource warm-up, unequal cancellations and dependent workloads prevent an invented significance or leak conclusion.

One unchanged DSA implementation passed 185,696 finite oracle comparisons with zero mismatches. It still used `classify_root` and lowercase statuses where the spoken source required `classify_route` and uppercase statuses, so its incorrect interface judgment is retained. The [substantive checks](evidence/recorded-substantive-checks-v71.json) preserve both findings without renaming the code.

## ChatGPT backend and current state

The earlier [backend comparison](evidence/answer-architecture-audit-corrected-v70.json) found faster ChatGPT direct-prompt first words in a small dependent sample after omitting an unsupported fast tier. Native playback produced transcripts but no ChatGPT answer jobs, so it did not measure a working live replacement. Switching backends alone has not been demonstrated to resolve the architecture delays.

All captures and all reviews are complete. The [policy comparison under the full audit](evidence/matched-policy-controls-final-audit-v71.json) records eleven correct and one incorrect existing-policy answer, versus nine correct, one incorrect and two incomplete final-only answers. Final-only also had the higher median first-word latency, 12.30 versus 11.48 seconds. These selected dependent cases do not support treating it as a universal fix.

The reporter's [input-key-ordering recovery](evidence/review-input-serialization-recovery-v71.json) preserved exact input values, recordings and judgments. The full audit verified every source binding and retained missing, erroneous, cancelled and unverified outcomes. The tested candidate remains separate because its native failure prevents a universal improvement claim. Required retention and no-prior-answer-display behaviors were not all demonstrated; the report does not certify a finished product fix. Git commits are local; pushing requires working GitHub authentication.
