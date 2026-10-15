# Meeting Copilot: UI and interview evaluation

The setup and answer overlay now share a restrained mint-and-ink design, an original pixel companion, clearer controls, readable code, and keyboard navigation. Context detection stays local until an explicit shortcut or button sends the selected project or screen.

The requested **100 distinct regular interviews and 20 distinct bug interviews are complete**, using the native signed-in app with **gpt-6.1-sol, low effort**. Every interview has three measured rounds. Changes were committed in atomic implementation, fix, and evidence batches.

## What changed

- Setup has Meeting, Answers, Context, and Camera tabs with persistent readiness/start controls, keyboard tab navigation, and bounded scrolling. Space UI/Base UI tabs, Componentry pixel effects, Canvas UI ripples, and original pixel art provide the visual character. Attribution and licenses are in `THIRD_PARTY_NOTICES.md`.
- The answer overlay keeps its footer reachable while long answers and code scroll independently. Fenced code and common unfenced JavaScript, Python, and SQL snippets receive code presentation, source-preserving highlighting, and copy controls.
- Active-context detection distinguishes VS Code, Explorer folders, and browsers. VS Code/Explorer handoffs attach the detected project; browser and web IDE surfaces use screen context. Detection does not upload context. Current attachment references prevent earlier projects from being treated as current.
- Global scrolling and window movement work while another application has focus. Reduced motion, non-intercepting visual effects, empty states, notices, and failure messages were checked.
- A native streaming bug was fixed: fragmented SSE events no longer repeatedly rescan an expanding prefix. The parser preserves Unicode and handles large batched events.

| Action | Shortcut |
| --- | --- |
| Send detected project or screen context | Ctrl+Shift+P |
| Send a screenshot | Ctrl+Shift+F8 |
| Scroll answers | Ctrl+Shift+Page Up / Page Down |
| Answer start / end | Ctrl+Shift+Home / End |
| Scroll visible code horizontally | Ctrl+Shift+Left / Right |
| Move the answer window | Ctrl+Alt+Arrow keys |

## Initial measured results

The corpus contains 25 LeetCode problems (15 hard, 5 medium, 5 easy), 75 additional synthetic technical scenarios, and 20 different injected project defects. These are simulated, text-driven interviews; audio was paused. Each explicit attachment shortcut triggered a context overview, followed by approach, implementation, and independent self-review rounds. Bug replacements were written to `src/core.mjs` and explicitly reattached before verification. Each attached bug project exposes its first smoke fixture; remaining grading fixtures and supplementary oracles remain outside it. This is an application workflow test, not a cold-start model benchmark.

| Check | Result |
| --- | --- |
| Distinct interviews completed and reviewed | 100 regular + 20 bug |
| Measured interview-round responses | 360 |
| Correct fresh markers | 120/120 |
| Exact accepted source-paint checks | 120/120 |
| Native keyboard reading and reachable footer | 120/120 |
| First / final implementation frozen fixtures | 119/120 each (99.2%) |
| Broader final implementation stress review | 91/120 (75.8%) |
| Broader review by kind | 77/100 regular; 14/20 bug fixes |
| Correct injected-defect diagnoses | 20/20 |

There were 34 browser screenshot, 43 VS Code project, and 43 Explorer project initial handoffs, plus 20 explicit patched-project handoffs. All detected source kinds and project identities matched. The raw evidence also retains 140 attachment-triggered overviews and two responses from incomplete interview attempts; neither group enters the 360-round accuracy/latency cohort.

| Latency from question confirmation | Median | p95 |
| --- | --- | --- |
| First answer word | 3.078 s | 7.872 s |
| First accepted visible paint | 3.115 s | 7.891 s |
| Completed answer | 7.763 s | 15.250 s |

These are nearest-rank percentiles over the latest completed attempt for each initial interview. Requested fast service tier is recorded; the backend did not report actual routing tier.

All 25 LeetCode final implementations passed their bounded contract reviews and functional fixtures, covering 1,820 fixture cases per implementation round across that cohort.

| LeetCode difficulty | Interviews | Final passes | First word median / p95 | Completion median / p95 |
| --- | --- | --- | --- | --- |
| Hard | 15 | 15 | 4.265 / 10.317 s | 10.866 / 20.848 s |
| Medium | 5 | 5 | 3.179 / 5.205 s | 7.584 / 14.255 s |
| Easy | 5 | 5 | 3.143 / 4.468 s | 6.702 / 11.062 s |

## Failures and the screenshot recheck

Frozen fixture accuracy does not establish correctness over every literal contract input. Independent stress review retained 29 final failures: 20 numerical precision/overflow failures, five practical depth/memory failures, three fractional capacity/limit failures, and one obscured screenshot. Synthetic contracts often omit numeric or size bounds; those broader results must not be confused with bounded LeetCode accuracy. Counterexamples, actual outputs, answer hashes, and complexity reviews are linked from the review ledger and final audit. The Unicode minimum-window task also leaves its length metric ambiguous; the chosen interpretation and competing witness are documented.

In the historical-lookup screenshot, a toolbar covered the no-match rule. The assistant identified the missing information and requested clarification rather than producing code. That failed initial attempt remains in the 119/120 and 91/120 scores. Toolbar ownership was not established, and the app already suppresses its answer overlay during capture; no application overlay defect is inferred.

A **separate recheck** used a fresh marker and narrower synthetic prompt. Computer Use verified the entire contract before sending it. Both returned implementations passed their four frozen fixtures and **1,556 independent history-query cases each**, along with source-paint and native reading checks. Its three response latencies and successful result are reported separately; they do not replace the initial failure or add a distinct interview.

## Validation and provenance

The measured app build passed the frontend build, six unit tests, 11 browser tests, and 210 Rust tests (14 ignored). Native acceptance separately verified setup scrolling, answer/code scrolling, physical window movement, display affinity, and explicit context handoffs. Seven 520×700 browser fixture captures are under `.impeccable/review/`; source-paint checks establish exact rendered source identity and offsets, not correctness of every syntax-colored pixel. The existing MSI predates these changes; this report covers source and the tested native debug build.

After measurement, three reference-helper gaps were repaired: empty minimum-window targets, zero products after overflow, and integer TTL deadline addition. All three regressions failed before the patch, then the full **11-test benchmark suite passed**. All 74 original bug fixture expectations and all 40 recorded bug implementation grades remained identical. The native binary/frontend hashes are unchanged. The changed reference hash and exact pre-repair contract bytes are archived; no recorded answer or initial score was changed.

- [Final audit and all failed-review evidence](evidence/interview-ui-final-audit.json)
- [Initial raw native run](evidence/interview-native-120-initial-results.json) and [reviewed summary](evidence/interview-native-120-initial-summary.json)
- [SHA-bound contract and diagnosis reviews](evidence/interview-contract-reviews.json)
- [LeetCode difficulty and latency details](evidence/interview-leetcode-25-summary.json)
- [Separate screenshot recheck review](evidence/interview-screenshot-context-recheck-review.json) and [raw recheck](evidence/interview-screenshot-context-recheck.json)
- [Reference repair verification](evidence/interview-reference-repair-verification.json) and [original contract bytes](evidence/interview-frozen-contract-snapshot.json)
- [Native UI acceptance](evidence/interview-ui-native-2026-10-14.json)
- [Reproduction protocol](../benchmarks/interviews/README.md)

The raw runner status says `responses_complete_pending_contract_review` because reviews are stored separately. The final audit verifies all 120 answer hashes against completed reviews, all handoffs and reading checks, the separate recheck, and the completed reference repairs. Historical checkpoint files and Git history retain earlier progress and assessments.

