# Context handoff benchmark — 14 October 2026

Live signed-in Codex through Meeting Copilot, **gpt-6.1-sol / low / Fast**, using exactly 15 Hard, 5 Medium, and 5 Easy LeetCode problems. Difficulty and IDs were verified against LeetCode's live GraphQL metadata; task descriptions are original paraphrases. Computer Use performed each explicit Ctrl+Shift+P handoff. Audio capture was paused; these measurements do not measure speech recognition.

25/25 implementations passed the small-input suite and recovered their current attachment marker. 1820/1820 functional checks passed. Large-input checks are reported separately below. A single successful run does not establish general accuracy.

| Group | Cases passing | First word median | First word p95 | Completion median | Completion p95 |
|---|---:|---:|---:|---:|---:|
| All | 25/25 | 4.27 s | 6.91 s | 9.57 s | 14.62 s |
| Hard | 15/15 | 5.04 s | 9.44 s | 10.97 s | 17.85 s |
| Medium | 5/5 | 4.36 s | 6.25 s | 8.64 s | 12.43 s |
| Easy | 5/5 | 3.63 s | 5.19 s | 5.96 s | 7.75 s |
| screenshot | 13/13 | 3.88 s | 6.17 s | 9.06 s | 12.43 s |
| project | 12/12 | 5.04 s | 9.44 s | 9.69 s | 17.85 s |

Native first-word latency starts at question confirmation and ends at receipt of the first alphanumeric answer character. Completion uses the native completed timestamp. Host rendered-text latency brackets are retained in the raw results; these are DOM visibility observations, not screen-paint measurements. Every attachment's initial automatic answer is preserved separately from the measured explicit implementation follow-up. Operator waits are excluded. Model account/catalog availability and binary SHA-256 are recorded in the raw evidence.

| Problem | Difficulty | Handoff | Checks passed | Marker | First word | Completion | Large-input result |
|---|---|---|---:|---|---:|---:|---|
| [4. Median Of Two Sorted Arrays](https://leetcode.com/problems/median-of-two-sorted-arrays/) | Hard | screenshot | 73/73 | pass | 3.19 s | 10.86 s | not sampled |
| [10. Regular Expression Matching](https://leetcode.com/problems/regular-expression-matching/) | Hard | project | 76/76 | pass | 5.04 s | 12.47 s | not sampled |
| [32. Longest Valid Parentheses](https://leetcode.com/problems/longest-valid-parentheses/) | Hard | screenshot | 75/75 | pass | 3.88 s | 7.11 s | pass |
| [42. Trapping Rain Water](https://leetcode.com/problems/trapping-rain-water/) | Hard | project | 72/72 | pass | 4.27 s | 7.93 s | pass |
| [44. Wildcard Matching](https://leetcode.com/problems/wildcard-matching/) | Hard | screenshot | 74/74 | pass | 5.08 s | 10.97 s | not sampled |
| [76. Minimum Window Substring](https://leetcode.com/problems/minimum-window-substring/) | Hard | project | 73/73 | pass | 6.38 s | 14.49 s | not sampled |
| [84. Largest Rectangle In Histogram](https://leetcode.com/problems/largest-rectangle-in-histogram/) | Hard | screenshot | 73/73 | pass | 3.55 s | 8.08 s | pass |
| [85. Maximal Rectangle](https://leetcode.com/problems/maximal-rectangle/) | Hard | project | 72/72 | pass | 5.78 s | 12.00 s | pass |
| [115. Distinct Subsequences](https://leetcode.com/problems/distinct-subsequences/) | Hard | screenshot | 73/73 | pass | 6.17 s | 12.08 s | pass |
| [132. Palindrome Partitioning Ii](https://leetcode.com/problems/palindrome-partitioning-ii/) | Hard | project | 73/73 | pass | 9.44 s | 14.62 s | pass |
| [239. Sliding Window Maximum](https://leetcode.com/problems/sliding-window-maximum/) | Hard | screenshot | 72/72 | pass | 3.30 s | 9.57 s | pass |
| [312. Burst Balloons](https://leetcode.com/problems/burst-balloons/) | Hard | project | 72/72 | pass | 5.81 s | 11.51 s | not sampled |
| [315. Count Of Smaller Numbers After Self](https://leetcode.com/problems/count-of-smaller-numbers-after-self/) | Hard | screenshot | 72/72 | pass | 3.81 s | 9.06 s | pass |
| [329. Longest Increasing Path In A Matrix](https://leetcode.com/problems/longest-increasing-path-in-a-matrix/) | Hard | project | 72/72 | pass | 6.91 s | 17.85 s | pass |
| [493. Reverse Pairs](https://leetcode.com/problems/reverse-pairs/) | Hard | screenshot | 74/74 | pass | 3.90 s | 10.48 s | pass |
| [3. Longest Substring Without Repeating Characters](https://leetcode.com/problems/longest-substring-without-repeating-characters/) | Medium | project | 73/73 | pass | 6.25 s | 9.69 s | pass |
| [33. Search In Rotated Sorted Array](https://leetcode.com/problems/search-in-rotated-sorted-array/) | Medium | screenshot | 72/72 | pass | 3.84 s | 8.21 s | not sampled |
| [56. Merge Intervals](https://leetcode.com/problems/merge-intervals/) | Medium | project | 72/72 | pass | 4.08 s | 8.64 s | not sampled |
| [200. Number Of Islands](https://leetcode.com/problems/number-of-islands/) | Medium | screenshot | 72/72 | pass | 5.37 s | 12.43 s | pass |
| [322. Coin Change](https://leetcode.com/problems/coin-change/) | Medium | project | 74/74 | pass | 4.36 s | 7.57 s | pass |
| [1. Two Sum](https://leetcode.com/problems/two-sum/) | Easy | screenshot | 72/72 | pass | 5.19 s | 7.75 s | not sampled |
| [20. Valid Parentheses](https://leetcode.com/problems/valid-parentheses/) | Easy | project | 73/73 | pass | 2.91 s | 6.72 s | pass |
| [121. Best Time To Buy And Sell Stock](https://leetcode.com/problems/best-time-to-buy-and-sell-stock/) | Easy | screenshot | 72/72 | pass | 3.90 s | 5.96 s | not sampled |
| [217. Contains Duplicate](https://leetcode.com/problems/contains-duplicate/) | Easy | project | 72/72 | pass | 3.60 s | 5.43 s | not sampled |
| [704. Binary Search](https://leetcode.com/problems/binary-search/) | Easy | screenshot | 72/72 | pass | 3.63 s | 5.46 s | not sampled |

The functional suite contains official-example equivalents, explicit edge cases, and 70 deterministic small random inputs per problem. Reference implementations use different or brute-force strategies. VM execution is bounded; candidate code receives no Node APIs. Large-input checks use closed-form expected results. These are local tests, not submissions to LeetCode's judge, and not exhaustive proofs of correctness or complexity.

## Bug-finding interview

The synthetic project contains an inventory reservation transaction bug spread across inventory, reservation, service, and test files. Constraints require atomic rejection, positive integer quantities, synchronous API, no dependencies or test edits, and idempotent retries. The assistant first diagnoses the source, then implements a complete replacement, then checks duplicate-SKU and invalid-quantity adversarial cases. Original source remains deliberately buggy as a reusable fixture.

Round 1: first word 5.93 s; completion 13.45 s.

Round 2: first word 5.19 s; completion 10.69 s. Independent implementation tests: 8/8; pass.

Round 3: first word 4.50 s; completion 16.25 s. Independent implementation tests: 8/8; pass.

## Handoff and product findings

Ctrl+Shift+P locally detects the foreground VS Code workspace or Explorer folder and explicitly attaches project text; browser IDEs use screenshots. Detection alone does not attach or ask. Ctrl+Alt+Arrow moves the focused setup window or otherwise the overlay by 40 logical pixels, clamped to the monitor work area. Source lookup respects the existing project collector's ignore rules, credential exclusions, and size limits. Browser handoff captures rendered content, not hidden IDE files. VS Code support currently resolves unambiguous single-folder workspace-storage records; multi-root and ambiguous workspaces need explicit selection.

A preserved pilot failure showed attachment-history interference: the initial answer correctly solved the new screenshot, but a follow-up referring generically to “TASK.md or visible task” selected the previous project's task. Formal prompts explicitly identify the current attachment type; therefore their success does not certify ambiguous mixed-history handoffs. This limitation is retained, not counted as a clean formal success. Explorer's collapsed breadcrumb path gap was fixed with shell-window lookup. Application detection was hardened to use process identity, preventing browser titles from impersonating VS Code.

The formal benchmark uses the frozen binary hash and source commit in the evidence. The latest native build separately passed real VS Code and Explorer detection, a browser-title spoofing check, local inspection without context transmission, overlay movement, and focused setup-window movement. These checks and that build's hash are in [control evidence](evidence/context-controls-2026-10-14.json). Final Rust validation: 206 passed, 14 ignored; frontend tests and production build passed.

The diagnosis counterexample was independently executed against the original fixture. The defective control fails six of eight transaction checks; both model-proposed replacements pass all eight. See [interview review](evidence/context-interview-review-2026-10-14.json).

Raw response text, per-case grades, native timelines, source attribution, pilot evidence, UI checks, and large-input results are committed alongside this report.

## Reproduce

Run `node --test benchmarks/context-handoff/oracles.test.mjs` to validate the offline grader. With the native debug app built and Codex signed in, run `node benchmarks/context-handoff/run.mjs`. At each HANDOFF_READY, use Computer Use to focus the displayed browser task or open the indicated folder in VS Code/Explorer, verify the actual active folder, press Ctrl+Shift+P, then POST to the local /ack endpoint. Never open a not-yet-created case folder: VS Code may interpret it as a filename. After completion, run grade-interview.mjs, verify-interview.mjs, stress.mjs, and summarize.mjs from the benchmark directory paths. The --controls-only run uses the same native setup for local detection and movement verification. Results are synthetic test material; no real account identifiers, project contents, or screenshots of private applications are published.
