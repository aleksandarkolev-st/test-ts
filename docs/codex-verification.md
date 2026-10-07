# Native Codex backend verification

Production 0.2.2 uses the signed-in native Codex account through the bundled official `codex-cli 0.160.1` stdio app-server. Its authenticated catalog includes exact `gpt-6-luna`. This path uses Codex's native provider rather than the separate ChatGPT-plan API adapter. Backend, model, answer speed and reasoning effort have independent controls.

Fast mode was requested and acknowledged as `priority`, the native protocol's accepted alias. See [OpenAI's Fast mode documentation](https://learn.chatgpt.com/docs/agent-configuration/speed). The app rejects an unacknowledged Fast selection instead of silently falling back.

## Production timing, 2026-10-07

Both runs used GPT-6 Luna, Codex, Fast mode, Nemotron English Q8, 160 ms chunks and Vulkan GPU 1. A synthetic meeting statement was played through actual WASAPI capture before three spoken questions. Every answer recalled the seeded date. Measurement starts at native speech end and ends at the first observed DOM answer text.

| Reasoning effort | Speech end to first visible answer, three samples | Median | Median request to first native token | Context recall |
| --- | --- | --- | --- | --- |
| xhigh | 3,341.5 / 3,381.5 / 3,808 ms | 3,381.5 ms | 2,780 ms | 3/3 |
| low | 3,326 / 3,955.5 / 3,086.5 ms | 3,326 ms | 2,645 ms | 3/3 |

Low effort's visible-answer median was 55.5 ms lower. Three samples per effort, cloud variability and clock/DOM uncertainty of 24–27 ms do not establish a reliable speed advantage. Median request-to-completion was 2,962 ms at xhigh and 2,783 ms at low. The request marker precedes Codex configuration/thread preparation, so request-to-token includes adapter work rather than isolating model-server time. Both efforts miss the two-second visible-answer target.

The prior ChatGPT-plan API GPT-5.6 Luna/xhigh run measured 2,326 ms median. Its different model, route and time prevent isolating the performance impact of Codex or Fast mode. These checks establish controlled context recall, rather than human meeting accuracy or a latency guarantee.

Reports, containing numeric measurements and verdicts, are ignored by Git:

- `artifacts/live-service/codex-gpt6-luna-fast-xhigh-production.json`
- `artifacts/live-service/codex-gpt6-luna-fast-low-production.json`
- `artifacts/codex/production-ui.json`: production version, authenticated backend and restored controls.
- `artifacts/codex-live-context/results.json`: actual Ctrl+Shift+P nested project facts and follow-up recall, actual Ctrl+Shift+F8 1920×1080 screenshot code/diagram understanding, removal and Stop.

After the low-effort test, the meeting was stopped and Codex/GPT-6 Luna/Fast/xhigh settings were restored and verified. The production app remains open and idle.

## Lifecycle and validation

Every answer and summary starts an ephemeral thread with history persistence disabled. Inherited MCP servers and plugins are disabled, as are shell, browsing and agent tools. Stop cancels generation and closes the owned Codex broker; a Windows job also cleans up descendants on parent exit. Codex manages native account credentials; the app does not copy them into packaged resources or logs. Meeting text and selected attachments still reach OpenAI for generation, subject to service data policies.

The source suite passed 47 Rust tests (three intentional opt-in tests skipped), two state tests and six browser tests. The opt-in live Codex test separately passed real streaming, cancellation and owned-process exit after Stop. Production model/context checks and extracted MSI resource checks passed; see [package verification](package-verification.md).

Bundled executable SHA-256: `9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d`. Original LICENSE and NOTICE are included. `scripts/setup-codex.ps1` prepares the pinned runtime without packaging account credentials.

To reproduce against a signed-in production app exposed on the local WebView CDP port, select Codex and Fast, then run:

```powershell
$env:COPILOT_LIVE_MODEL='gpt-6-luna'
$env:COPILOT_LIVE_REASONING_EFFORT='low'
$env:COPILOT_LIVE_SAMPLES='3'
$env:COPILOT_LIVE_REAL_AUDIO='1'
$env:COPILOT_LIVE_CONTEXT_CHECK='1'
$env:COPILOT_LIVE_PAUSE_CAPTURE='0'
$env:COPILOT_LIVE_RESULTS_FILE='codex-gpt6-luna-fast-low-production.json'
node scripts/live-service-check.mjs
```

The helper restores prior settings during cleanup. Replace `low` with `xhigh` and choose a distinct result filename for the other effort.
