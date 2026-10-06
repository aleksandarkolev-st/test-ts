# Nemotron integration evidence

The default meeting backend now uses the official NVIDIA NeMo-Speech.cpp 0.2.0 Windows Vulkan runtime and the pinned Nemotron Speech Streaming EN 0.6B English Q8 GGUF. Two authenticated loopback WebSockets own independent SELF and REMOTE caches; audio is sent incrementally and is never uploaded. The runtime is contained in a Windows kill-on-close job so it cannot outlive the app process. Pause closes the source sockets; resume opens fresh states against the loaded model. Stop and cancelled loading release the child/model. Stale startup results cannot restart a stopped session.

On this computer, GGML and DXGI device enumeration both identify integrated AMD graphics at index 0 and RX 9070 XT at index 1. Selecting the integrated adapter made inference slow. With the discrete adapter, the server's default neural batching still stalled concurrent realtime requests; disabling neural batching let both streams advance correctly. This does not disable the model's streaming cache.

All four native right-context settings passed `scripts/nemotron-smoke.mjs` with distinct synthetic WAV phrases, independent partial/final events, correct recognition, and partials before the final input chunk. Evidence is written to `artifacts/nemotron/streaming-<chunk>-vulkan-1.json`.

| Chunk | RNNT right context | First partial REMOTE / SELF |
| --- | --- | --- |
| 80 ms | 0 | 431 / 509 ms |
| 160 ms | 1 | 509 / 506 ms |
| 560 ms | 6 | 1711 / 1711 ms |
| 1120 ms | 13 | 2299 / 2293 ms |

These first-partial numbers depend on phrase content and are measured from the first input packet. Final events sometimes occur before the WAV ends because the WAV contains trailing silence. Negative final-after-send values do not describe end-of-speech latency.

Native acceptance with `COPILOT_REAL_AUDIO=1` and `COPILOT_NATIVE_ARTIFACT_NAME=native-nemotron` passed actual playback → WASAPI loopback → local Nemotron → detected question → local Responses HTTP fixture → overlay. Speech-end-to-first native answer token was 685 ms in that controlled run. This is a synthetic local answer fixture, not a DOM-appearance or OpenAI-account latency measurement. The older real-account xhigh latency benchmark remains historical and does not establish the upgraded end-to-end latency.

The first three-sample production run answered two questions but stalled at confirmation on the third. The independent RNNT final can arrive before the local VAD end event; the detector previously waited for a second final even if the first already covered that audio endpoint. It now tracks final coverage within each speech turn and accepts either event ordering, while requiring a fresh final for the next turn. A focused regression test and a native run with three consecutive actual audio questions pass. The rebuilt MSI contains this fix; updated real-account measurement must use that build.

The same native run passed loading cancellation, pause/resume, SELF suppression, continued-question cancellation, full project and actual PNG screenshot shortcuts, focus preservation, removal, and Stop while capture work was in flight. Rust transport tests check PCM conversion, all cache mappings, source isolation and cancellation of idle reads. The browser tests and frontend build pass.

Nemotron's plain RNNT transcript did not include a question mark. The question detector now recognizes unpunctuated direct interrogative grammar (for example, “What is our launch target…”), while preserving the declarative/rhetorical exclusions. Broader conversational accuracy, long meetings and upgraded real-account latency still need live validation.

Primary references: [official runtime](https://github.com/NVIDIA/NeMo-Speech.cpp/tree/v0.2.0), [cache and batching configuration](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/docs/asr/configuration.md), [model card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b).
