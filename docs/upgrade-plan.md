# Current requested upgrade

The goal combines the attached gaze-correction brief with Nemotron streaming speech, screenshot and project shortcuts, and small atomic commits. This document records the complete scope; passing the context tests does not complete the goal.

| Requirement | Current evidence | Remaining work |
| --- | --- | --- |
| Read the supplied attachment | Read `pasted-text-1.txt` from the supplied attachment path | Preserve its downward-note-reading, local AMD, low-latency camera requirements |
| Nemotron Speech Streaming EN 0.6B | Official 0.2.0 Windows Vulkan runtime installed and checksum verified; CLI runs; official English Q8 weights pinned to revision `ebe59e5a817142986528bbbee5dba8db7b38ed50` | Validate actual inference; integrate independent SELF/REMOTE streaming caches into WASAPI pipeline; stop/pause/error cleanup; user-selectable 80/160/560/1120 ms chunks; measure actual latency and recognition |
| Screenshot shortcut | Native Ctrl+Shift+F8 dispatch, PNG content/dimensions, focus preservation, follow-up reuse, removal and Stop during capture pass the local fixture harness | Verify real signed-in model understands an explicitly controlled screenshot; update packaged app |
| Project shortcut | Native Ctrl+Shift+P dispatch, full nested readable source in request, exclusion rules, reporting, follow-up reuse/removal pass | Check real-account context/recall with a controlled project; update packaged app |
| Natural downward-gaze correction on RX 9070 XT | Attachment specifies face landmarks, eye crops, small learned eye warp, blending, narrow vertical envelope and OBS Virtual Camera output | Implement and verify the actual camera pipeline and AMD inference; calibrate roughly 10–15 degree downward range and slight horizontal tolerance; preserve blinks/rest of face; measure frame delay and stability; expose start/stop and calibration controls; verify OBS output |
| Atomic commits | Baseline plus separate collection, project integration, image transport, and screenshot integration commits | Continue committing independent tested changes |
| Usable updated Windows distribution | Existing installer predates these changes | Build, inspect and smoke-test new installer with actual runtime/model/camera resources and required notices |

## Runtime choice and evidence

NVIDIA's [model card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b) describes cache-aware FastConformer/RNNT, 600M parameters and four chunk configurations. The [official native runtime](https://github.com/NVIDIA/NeMo-Speech.cpp) has Windows/Vulkan support. Its [streaming configuration](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/docs/asr/configuration.md) maps RNNT right-context values 0, 1, 6 and 13 to the requested chunks. A separate local process avoids loading incompatible Whisper and Nemotron GGML DLLs into the same address space. Raw meeting audio must remain on the device.

The current [WangWilly reference](https://github.com/WangWilly/gaze-correction-cam) presents a macOS app and TensorFlow source, so it cannot simply be added as a Windows/AMD dependency. Inspect its FLX eye-warp checkpoint and preprocessing before choosing an ONNX/DirectML or equivalent AMD path. A generic face transform or cosmetic eye movement does not satisfy the supplied learned-correction brief.

Published cloud WER figures in the request are motivation, not acceptance evidence for this machine. The implementation needs its own controlled recognition, latency and two-source isolation measurements. Do not claim the older two-second answer target is met without measuring the complete speech-end-to-visible-answer path.

## Local preparation and checks

`scripts/setup-nemotron.ps1` installs only inside the workspace, with pinned runtime/model SHA-256 checks. `-RuntimeOnly` skips the weights. `scripts/nemotron-smoke.mjs` launches the official runtime on loopback, feeds two distinct synthetic WAVs over independent realtime WebSockets, requires partial/final transcript events and expected phrase matches, and records numeric evidence under `artifacts/nemotron`. Set `COPILOT_NEMOTRON_CHUNK_MS` to each supported chunk value. This preparatory check does not prove integration into the app.

Preparation on this machine: runtime and all 699,872,960 model bytes passed their pinned hashes. The first GPU service attempt reached the harness's 120-second cold-start limit before binding its listener. The subsequent attempt uses a 600-second loading bound and remains under observation; do not restart it because an observation call yields. Inspect the live tool session and process before treating it as stopped.

Gaze research checkout: `.local/gaze-reference` at `a94ec5979b634a7bc812a879a2ebe15ca7d4f6c1`. The released `v0.1.1/weights.zip` was downloaded and extracted under `.local/gaze-weights`; its observed SHA-256 is `07279dd9072f784e32c26e0c40bdf10270f98c6f3e9b3effc3254c4ce05fa76a`. It contains real L/R FLX checkpoints for 48×64 eye images, 12-channel anchor maps and a two-angle input, trained in 2018 with zero head pose. Export/parity verification must precede any naturalness or AMD performance claim. Python 3.11.16 is already installed and is compatible with the converter's documented TensorFlow 2.13–2.15 test range.
