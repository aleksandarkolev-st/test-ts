# Interview evaluation protocol

The requested scope is **100 distinct technical interviews and 20 distinct bug interviews**, each with three rounds. `catalog.mjs` contains 100 different contracts; 25 reference the earlier LeetCode tasks and 75 cover additional algorithm, parsing, graph, cache, and scheduling topics. `bugs.mjs` contains 20 distinct injected defect mechanisms, independent reference functions, and executable failing witnesses. The synthetic projects have contracts, source, service wrappers, and smoke tests.

Preparation and a passing grader self-test do not count as live interviews. `prepared.json` starts with every case pending. The final evaluation must preserve each native context handoff, all actual questions and answers, marker verification, runnable implementation tests, latency, visible source acknowledgements, code rendering, and keyboard-scroll results. Keep original failures and reruns separate. Use the previously requested GPT-6.1 Sol with low effort unless the user changes that preference.

The regular interviews ask for reasoning, an implementation, and adversarial self-review. Bug interviews ask for exact source diagnosis and a counterexample, a constrained source replacement, and adversarial verification of that replacement. No hidden oracle or grading witness is placed in attached projects. Audio-independent trials must be labeled as such; successful text trials do not establish ASR reliability.

Run `node --test benchmarks/interviews/*.test.mjs` to check catalog uniqueness and that every defective control fails an executable witness while every reference control passes. Run `node benchmarks/interviews/prepare.mjs` to materialize fixtures under `.local/interview-suite/projects`. The additional 75 tasks have 307 frozen functional fixtures in cases.mjs, with independent cross-checks for overlapping bug contracts and exact string arithmetic.


The live runner run.mjs collects actual native responses, source-paint acknowledgements, latency and executable grades. Start with node benchmarks/interviews/run.mjs --pilot --limit=1; pilots are excluded from the required corpus. The full run uses node benchmarks/interviews/run.mjs; --resume requires the same binary, frontend, and contracts and preserves incomplete attempts.

The localhost:9571/state endpoint advertises each Computer Use handoff or reading check. Its /ack endpoint requires the matching token. The harness never sends context automatically: Computer Use focuses the synthetic browser, VS Code folder, or Explorer folder and presses Ctrl+Shift+P. Bug round 2 replacements are reattached before round 3.

Functional grades do not establish complexity or diagnosis. Those contract reviews remain pending until actual answers are inspected. The responses_complete_pending_contract_review status is not the goal completion gate. The first three counted interviews and their manual reviews are preserved in docs/evidence/interview-counted-first-three-2026-10-14.json and interview-counted-first-three-review.md; subsequent progress remains in artifacts/interview-suite/results.json.

For horizontal reading checks, first bring the code into view (for example, Home then End, then Right/Left). The shortcut intentionally targets the focused or visible code block. Preserve failed observations and explain any corrected test targeting rather than overwriting the failure evidence.
