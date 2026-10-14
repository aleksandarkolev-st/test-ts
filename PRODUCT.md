# Meeting Copilot

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The user prepares for and takes coding interviews, reads suggested answers, and discusses bugs in a local project or a browser IDE.

## Product Purpose

Provide readable answers with the current screen or project as useful evidence. Both setup and the answer overlay should feel finished (confirmed by the user).

## Operating Context

React in a Tauri Windows application. The user may have VS Code, Explorer, or a web IDE open. The overlay accompanies a call; setup configures accounts, audio, local transcription, answers, and optional camera correction.

## Capabilities and Constraints

- Detect the relevant project or screen locally; send it only when the user explicitly uses the shortcut or control.
- Offer keyboard shortcuts for window movement, answer scrolling, and context sharing.
- Keep code readable in answers and retain its exact source for visibility measurements (confirmed priority).
- Preserve the existing account, audio, camera, and overlay protection behavior.
- Use GPT-6.1 Sol with low reasoning for the requested evaluation assistant.

## Evidence on Hand

The earlier 25-problem evaluation is documented in `docs/context-handoff-benchmark.md`. The current 100-interview and 20-bug-interview corpus is prepared in `benchmarks/interviews`; preparation is not evidence that its live runs succeeded.

## Product Principles

- Context sharing is deliberate and visible.
- Reading an answer and operating the application both work from the keyboard.
- Keep code and project evidence faithful to their source.
- Record measured results and failures without overstating coverage.
