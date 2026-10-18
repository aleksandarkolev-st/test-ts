# Screen monitoring, answers, and keyboard typing

Status: **implemented, opt-in, off by default** — with the honest limits listed below. The
feature is one part of the app: a screen monitor that watches whatever screen is in front,
a RAM-only answer cache, and a keyboard typist that sends the cached answer through a QMK
RAW HID bridge so the keystrokes come from the keyboard's own USB device instead of a
synthetic host input call. Form submission itself is never performed by the app.

## Pipeline

1. **Capture** (`monitor/service.rs`, `attachments/screenshot.rs`): while a meeting runs and
   `screenMonitorEnabled` is set, the service checks the foreground window every
   `screenMonitorIntervalSeconds` (2–300, default 5) and captures **the whole monitor that
   is in front** — everything visible on the screen that contains the foreground window,
   whatever application it is (no application allowlist). Capture pauses while the
   Copilot's own window is frontmost, and capture width is capped at 1440. Consecutive
   frames are compared by pixel hash; an unchanged frame skips analysis.
2. **Vision analysis** (`monitor/vision.rs`, prompt `MONITOR_ANALYSIS`): the frame goes to
   the configured vision model as untrusted reference data, which returns one JSON object
   `{question, focus, password, note}`. `focus` is true only when the screenshot shows a
   focused input (visible caret or active outline); `password` is true when any visible
   focused field is a password field.
3. **Answer generation** (`openai/prompts.rs` prompt `MONITOR_SOLUTION`): for a new
   question (deduplicated by `QuestionDeduper`), the app asks for **only the exact text to
   type — no explanation**, and caches it in `AnswerCache` (`attachments/screen_monitor.rs`)
   with a 300-second TTL keyed to the question and a generation id. Nothing is written to
   SQLite; answers live in RAM only. Results over 8000 characters are warned about and not
   cached.
4. **Focus gate and typing** (`runtime.rs::type_monitor_answer`, `monitor/typing.rs`): the
   dedicated typing thread owns the HID bridge. The app types a cached answer only when
   *all* of the following hold:
   - `screenMonitorTyping` is enabled and the answer is fresh for the current question;
   - vision `focus` evidence is at most 30 seconds old and was seen for the same window;
   - the live foreground window (re-checked immediately before typing) still matches that
     window handle and executable;
   - the committed eligibility rules (`field_is_eligible`) pass and
     `InsertionGuard::authorize_once` authorizes this generation — one typing attempt per
     answer, cleared by a `focus:false` or `password:true` analysis.
5. **Keyboard bridge** (`monitor/hid.rs`, `monitor/protocol.rs`): candidate HID interfaces
   on usage page `0xFF60` / usage `0x61` are opened and only the one answering the frozen
   PING/PONG handshake (firmware protocol version 2) is used — VIA-only keyboards are
   skipped without typing. The answer text is first turned into a byte *typing plan* that
   compensates for the target editor's auto-indentation and auto-closing brackets (so the
   answer ends up formatted exactly as written; the plan may include `0x08` backspace and
   `0x7F` delete opcodes), then sent as acknowledged 29-byte chunks; the firmware paces real
   keystrokes (default press 8 ms / gap 18 ms; Slow 12/40, Fast 4/8) and the host checks an
   abort flag between chunks.

If the keyboard bridge cannot be reached, **typing is refused and the overlay shows a
warning**; there is no `SendInput` fallback anywhere in the codebase. The kill switch
(**Ctrl + Shift + F12**, or the overlay's **Stop typing** button) aborts the worker in
flight and issues CLEAR to drop everything still queued in the firmware.

## Wire protocol (frozen)

Every report is 32 bytes, usage page `0xFF60` / usage `0x61`.

| Direction | Byte 0 | Byte 1 | Payload | Reply |
| --- | --- | --- | --- | --- |
| host → device | `0x53` | `0x01` | — | PONG `[0x81]` |
| host → device | `0x53` | `0x02` | `[press_ms, gap_ms]` (firmware clamps 2–200 / 1–200) | CONFIG_ACK `[0x82]` |
| host → device | `0x53` | `0x03` | `[len 1..29][bytes]` | PONG, or NACK `[0x83]` code 2 (queue full) / 3 (bad text) |
| host → device | `0x53` | `0x04` | — | PONG (queue emptied, held key released) |
| device → host | `0x53` | `0x81` | version, queue length, typing state | — |

Queue: 512 bytes, overflow reported as NACK 2, never silently dropped. Typable bytes are
`0x08` (Backspace), `0x09` (Tab), `0x0A` (newline), `0x7F` (Delete), and `0x20..0x7E`;
Unicode punctuation is transliterated first, and anything not representable on a US ANSI
keyboard fails explicitly rather than typing the wrong character. The four non-printable
bytes map to their own keys on the keyboard (`KC_BSPC`, `KC_TAB`, `KC_ENTER`, `KC_DEL`).
The typing plan uses `0x08` and `0x7F` to steer the editor: Monaco (LeetCode's editor)
re-indents lines after Enter, inserts closing brackets automatically when an opener is
typed, and rewrites the leading whitespace of a line that starts with a closing bracket —
the plan tracks all of that and removes the editor's insertions so the final text matches
the answer. See `src-tauri/src/monitor/protocol.rs` for the single source of truth and its
tests (including a simulator of the editor behaviors).

## Human performance (app-side)

By default (settings `screen_monitor_human` / `screen_monitor_human_minutes`, UI "Type like
a human", 1–120 minutes) one answer is spread over a target session length — 30 minutes
default — instead of being typed as fast as the firmware accepts. The planner is
`plan_performance` in `src-tauri/src/monitor/protocol.rs`:

- The answer first becomes the usual [`plan_typing`] byte stream, then that stream is wrapped
  into segments of at most 29 bytes with a pause after each.
- Occasional wrong-key slips (a QWERTY-neighbour letter, a beat, then Backspace) and second
  thoughts (type an alternative identifier or a false start, delete it, then type what the
  answer actually says) are woven between words. Both styles insert only plain letters and
  remove them again before the next planned byte, so the editor still ends up with exactly
  the answer.
- Pauses are drawn from natural distributions (long after Enter, short mid-word) and scaled
  so `lead + typing + pauses` lands on the target. No single pause is allowed past 180 s;
  when a short answer cannot absorb the budget in pauses, what is left becomes one opening
  "reading the problem" pause.
- The schedule is deterministic per `(seed, spec)`; the seed mixes the dispatch time with
  the answer generation.

On the wire nothing changes: the keyboard only ever receives ordinary `TEXT` chunks. The
pauses are app-side sleeps that re-check the abort flag and the foreground window every
100 ms, so **Ctrl + Shift + F12**, a window switch, or the meeting stopping ends a
half-hour performance within a moment. While a performance is running, its generation stays
locked for the full budget, and a new question aborts the old performance before dispatching
its own.

## Honest limits

- **Automated input.** Typing is automated input that this app causes. The events are real
  hardware HID reports from the keyboard's USB device, but they are *not* human-originated,
  and this project makes no claim that they are undetectable or that they fool any
  particular detection scheme. Do not use them to misrepresent who is answering. Human mode
  changes the rhythm — pauses, slips, second thoughts — not that fact.
- **Focus detection is vision-only.** There is no UI Automation or TSF check that the
  focused control is an editable text field; that is why typing additionally requires the
  vision `focus` flag, a live foreground re-check, and a per-generation guard. A wrong
  focus analysis can still cause text to land in the wrong focused control of the watched
  window.
- **Line breaks are Enter keystrokes.** The app never presses a separate submit control,
  but an answer's internal newlines (common in code) are typed as Enter. In an app where
  Enter sends a message, a multi-line answer can submit it — prefer code editors, quiz
  forms, and similar fields where Enter does not send, and keep **Ctrl + Shift + F12**
  within reach.
- **Question flapping regenerates answers.** When the analysis alternates between
  question texts (for example a ticker or animation), each change starts a new generation
  and a new model request; there is no smoothing beyond the deduper.
- **US ANSI ASCII only, one layout.** No IME, no dead keys, no Unicode; newline is `KC_ENTER`.
- **Firmware is flashed and hardware-verified.** The keymap in `firmware/gmmk2-96/` runs on
  a real GMMK 2 96% ANSI: the v1 image (2026-10-17, readback byte-compared) was verified
  typing a probe sentence, and the current v2 image (2026-10-18, SHA-256
  `D6058F1FF7EF008B426E9B0BDA66B0359000C59B56A5BF38F7EBBAF068A6F819`, written at
  `0x08000000` through the WB32 DFU bootloader) answers PING with protocol version 2. The
  v2 compensation typing in a real editor is still being validated on hardware; the
  VIA-enabled build variant remains source-verified only. See that folder's README for
  details and the stock-restore procedure.
- **Answers are ephemeral.** RAM-only, 300-second TTL, replaced when the question changes,
  and cleared when the meeting stops. This does not make the feature undetectable; it only
  keeps the app's own storage honest.

## Why not TSF

TSF insertion (`ITfInsertAtSelection::InsertTextAtSelection`) requires a TSF edit context
and a write-capable edit cookie; it can fail with no document lock, no selection, or a
read-only selection ([Microsoft API reference](https://learn.microsoft.com/en-us/windows/win32/api/msctf/nf-msctf-itfinsertatselection-inserttextatselection)).
TSF text services cooperate with applications through the TSF manager, and edit sessions
are requested against a specific context ([TSF architecture](https://learn.microsoft.com/en-us/windows/win32/tsf/architecture), [edit sessions](https://learn.microsoft.com/en-us/windows/win32/tsf/edit-sessions)),
so it is not a general external-process API for inserting into arbitrary focused
applications. A real TSF backend would need a registered text service and
per-application compatibility testing; it is not implemented here.

## Glorious GMMK 2 96%

Glorious documents QMK support for GMMK 2 and lists the 96% ANSI target as
`gmmk/gmmk2/p96/ansi` ([Glorious installation guide](https://www.gloriousgaming.com/blogs/guides-resources/gmmk-2-qmk-installation-guide), [96% product guide](https://www.gloriousgaming.com/en-de/pages/guide-gmmk2-96)).
The keymap in `firmware/gmmk2-96/` adds the RAW HID screen-typing module to that board.
The firmware bootloader entry is Escape while plugging in (`wb32-dfu`). The keyboard's
own USB device emits the keystrokes; this is still automated input, as stated above.

## Safety boundary

- The app captures only the monitor that is in front, only while a meeting runs and the
  screen monitor is enabled, and never captures its own windows.
- Answer text is typed only after vision shows the field focused, the live foreground
  window is re-checked, and the per-generation guard authorizes one attempt. The same check
  runs between chunks: switching away stops the typing. An attempt that was stopped after
  some bytes were typed is final — a partial answer is never retyped on top of itself.
- The app never triggers a submit control on its own — but see the Enter-keystroke limit above
  before typing into chat-style inputs.
- **Ctrl + Shift + F12** (or **Stop typing** in the overlay) aborts typing immediately,
  clears the firmware queue, and requires fresh focus evidence before another attempt.
- If the keyboard cannot be reached, nothing is typed and the overlay warns; the app never
  falls back to synthetic host input.

## Key files

| Area | Files |
| --- | --- |
| Monitor loop, status | `src-tauri/src/monitor/service.rs`, `src-tauri/src/meeting/state.rs` |
| Capture and frame gating | `src-tauri/src/attachments/screenshot.rs` |
| Policy, cache, focus rules | `src-tauri/src/attachments/screen_monitor.rs` |
| Vision parsing | `src-tauri/src/monitor/vision.rs`, `src-tauri/src/openai/prompts.rs` |
| Typing worker | `src-tauri/src/monitor/typing.rs` |
| HID bridge | `src-tauri/src/monitor/hid.rs`, `src-tauri/src/monitor/protocol.rs` |
| Wiring, kill switch, settings | `src-tauri/src/runtime.rs` |
| Firmware | `firmware/gmmk2-96/` (see its README) |
| UI | `src/ScreenMonitor.tsx`, `src/overlay/monitorFormat.ts` |
