The current assistant preference is signed-in Codex, `gpt-6.1-sol`, low reasoning, Fast tier. It was saved and read back from the idle production app on 2026-10-10. Existing Luna measurements remain Luna measurements; a settings change does not establish new latency or accuracy results.

Interview and offline data tools allow model overrides rather than fixing a model in request bodies:

| Tool | Model configuration | Reasoning configuration |
| --- | --- | --- |
| Native adaptive interview candidate | `COPILOT_NATIVE_ANSWER_MODEL`, then `COPILOT_INTERVIEW_MODEL` | `COPILOT_NATIVE_ANSWER_EFFORT` |
| Interview examiner | `COPILOT_INTERVIEW_EXAMINER_MODEL` | `COPILOT_INTERVIEW_EXAMINER_EFFORT` |
| Intent data generator | `COPILOT_INTENT_GENERATOR_MODEL`, then `COPILOT_INTERVIEW_MODEL` | `COPILOT_INTENT_GENERATOR_EFFORT` |
| Offline prefix annotator | `COPILOT_INTENT_LABEL_MODEL`, then `COPILOT_INTERVIEW_MODEL` | `COPILOT_INTENT_LABEL_EFFORT` |
| Production settings restore | `COPILOT_LIVE_MODEL` | `COPILOT_LIVE_EFFORT` |

Defaults follow the current preference. Native probes and settings restore reject a requested model absent from the signed-in catalog. Probe records and generated corpora identify the configured model and reasoning effort. Changing the generator does not retrain or promote the local intent classifier. Synthetic annotations still need independent review.

Interview questions continue to be generated from a fresh run identifier and the requested brief. These configuration defaults introduce no question matching, topic-based routing, cached answers, or canned responses.

The two-turn [model-switch smoke evidence](evidence/model-switch-sol-v65.json) verifies the new model through the native scheduler and overlay, with clean shutdown. Retained first-text times were 1,613 ms and 7,255 ms after simulated speech end. This excludes ASR and does not meet the near-instant goal. The subsequent [fresh paired rapid-fire comparison](rapid-comparison-v66.md) records Luna's lower latency and Sol's greater task coverage on two merged bursts each; it establishes no general model ranking. New hour-long Sol audio and audio rapid-fire measurements remain outstanding.
