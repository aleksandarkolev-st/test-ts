# Requested upgrade status

The attached brief was read before implementation. Its scope is small downward note-reading eye correction, local AMD inference, low latency and natural call appearance. Passing software or transport checks alone does not establish naturalness on a real person.

| Requirement | Current evidence | Remaining verification |
| --- | --- | --- |
| Nemotron Speech Streaming EN 0.6B | Default native backend; independent SELF/REMOTE caches; selectable 80/160/560/1120 ms; all four actual Vulkan streaming runs pass on RX 9070 XT; responsive loading cancellation, pause/resume and native WASAPI acceptance pass; three signed-in real-audio samples complete with context recall | Two-second latency target remains unmet; broader recognition and long-meeting stability |
| Screenshot shortcut | Ctrl+Shift+F8 performs native full-resolution lossless PNG capture; verified focus preservation, follow-up reuse, removal and stale-work cleanup; signed-in model reads controlled image code and both diagram labels | Broader real-world image understanding |
| Project shortcut | Ctrl+Shift+P reads complete nested text with ignore/exclusion rules and explicit size errors; verified request contents, follow-up reuse/removal; signed-in model recalls all three controlled nested source facts | Model context limits for large real projects |
| Downward eye correction | Original trained FLX graphs exported with CPU/DirectML parity; actual RX GPU kernels measured; MediaPipe tracking, RGB eye crops, eye-only blending, bounded angles, blink/head-turn passthrough, ordered calibration and native UI implemented; independent 1280 × 720 OBS output passes | Connect a face-bearing input, calibrate camera/notes, inspect naturalness, tracking stability and complete call latency |
| Atomic commits | Separate source collection, project transport, image transport, screenshot lifecycle, Nemotron integration, FLX export and camera integration commits | Continue committing independently tested distribution and live checks |
| Updated Windows distribution | 0.2.0 MSI built with complete Nemotron runtime/weights, standalone camera worker, both FLX models, MediaPipe task and original notices; extraction and production checks pass, including 946 resource hashes and frozen camera preview | Clean-machine installer upgrade/uninstall behavior |

See [Nemotron evidence](nemotron-verification.md), [FLX numeric evidence](gaze-models.md), [camera evidence and input limitations](camera-verification.md), [package evidence](package-verification.md) and [signed-in upgrade checks](live-upgrade-verification.md). Detailed generated reports remain under ignored `artifacts/`.

On this machine, integrated AMD graphics is adapter 0 and RX 9070 XT is adapter 1 in both Vulkan and DXGI. The pinned NVIDIA runtime requires neural batching disabled for the tested two-source realtime workload; cache-aware streaming remains enabled. Camo is the only eligible input, and currently supplies no detectable face, sometimes only about 1 fps. OBS Virtual Camera is an output and is excluded as an input.

Published WER figures in the request motivate the change; they are not measurements of this local Q8 implementation. The upgraded GPT-5.6 Luna/xhigh real-account benchmark measured 2.326 seconds median speech-end-to-visible-answer and recalled the seeded fact in all three samples. The two-second target remains unmet. Historical Whisper measured 5.79 seconds; the 685 ms local Responses fixture result is a different measurement scope and must not be treated as real-account performance.
