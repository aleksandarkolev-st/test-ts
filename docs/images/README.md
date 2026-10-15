# README media

These images capture the real React interface with synthetic data. No live account, microphone, project, screen capture, or AI service is used. The animation contains a scripted answer and does not represent measured service speed. Windows title bars, taskbar behavior, and native capture exclusion are outside this browser demonstration.

| File | Content |
| --- | --- |
| `meeting-setup.png` | Meeting devices and local speech configuration. |
| `answer-settings.png` | Account, answer model, style, effort, and speed. |
| `interview-task.png` | Saved problem statement and refreshed test output. |
| `answer-overlay.png` | Suggested answer with task context. |
| `interview-walkthrough.gif` | Save problem → attach context → question → sample streamed answer → New task. |

Regenerate from the repository root after installing npm dependencies. You also need FFmpeg on PATH and Edge on Windows, or Playwright Chromium on other platforms:

```powershell
node scripts/readme-media.mjs
```

The script starts an isolated Vite server on `127.0.0.1:1431`, blocks browser requests to other origins, and closes its browser and server on exit. It asserts visible UI states before capturing, uses UTC timestamps and an `.invalid` demo account, and writes temporary frames under `.local/`. It does not connect to or alter a running desktop app. Inspect regenerated PNGs and the GIF before committing them.

The GIF loops for 16 seconds at 600 × 780. The main README also links still images so the workflow is available without watching motion.
