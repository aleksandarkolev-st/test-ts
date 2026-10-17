# Screen typing firmware — Glorious GMMK 2 96% ANSI (`gmmk/gmmk2/p96/ansi`)

A QMK keymap + module that lets a Windows application (the Tauri app this repo belongs to)
stream answer text to the keyboard over RAW HID. The keyboard then **emits real HID keyboard
reports itself** — the keystrokes come from the keyboard's own USB device, not from a
synthetic `SendInput` call, so they keep working independently of what the host application
is doing.

**Honest description:** this is still automated input. The events are real hardware HID
reports, but they are *not* human-originated, and this firmware makes no claim of being
undetectable or of fooling any particular detection scheme. This matches the stance already
recorded in `docs/screen-monitoring-backends.md` in the application repo.

## Files

| File              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `screen_typing.h` | Public interface: protocol constants, init/task/handler declarations.   |
| `screen_typing.c` | Ring buffer, packet parsing, typing state machine, PONG/ACK/NACK replies. |
| `rules.mk`        | `RAW_ENABLE = yes` + `SRC += screen_typing.c` (+ VIA notes).            |
| `keymap.c`        | Mirrors the board's default keymap; wires the module into QMK hooks.    |
| `README.md`       | This file.                                                              |

This folder is a drop-in **keymap folder**: copy it to
`keyboards/gmmk/gmmk2/p96/ansi/keymaps/screen_typing/` inside a QMK firmware checkout.

## Verified integration points (QMK `master`, sources fetched 2026-10-17)

**Receive hook.** `quantum/raw_hid.h` documents `raw_hid_receive(uint8_t *data, uint8_t
length)` — "Always 32 bytes in length". `quantum/raw_hid.c` defines it **weak**:

```c
__attribute__((weak)) void raw_hid_receive(uint8_t *data, uint8_t length) {
    // Users should #include "raw_hid.h" in their own code
    // and implement this function there. Leave this as weak linkage
    // so users can opt to not handle data coming in.
}
```

`quantum/via.c` (compiled only when `VIA_ENABLE = yes`, see `builddefs/generic_features.mk`
which adds `-DVIA_ENABLE` and `quantum/via.c`) defines a **strong** `raw_hid_receive()` that
first forwards to a weak sub-hook:

```c
__attribute__((weak)) bool via_command_kb(uint8_t *data, uint8_t length) {
    return false;
}

void raw_hid_receive(uint8_t *data, uint8_t length) {
    ...
    // If via_command_kb() returns true, the command was fully
    // handled, including calling raw_hid_send()
    if (via_command_kb(data, length)) {
        return;
    }
    ...
```

Consequences, and what this keymap does:

- `VIA_ENABLE` off → the keymap overrides `raw_hid_receive()` (the documented pattern).
- `VIA_ENABLE` on → the keymap **must not** define `raw_hid_receive()`: `via.c` already does
  (strong symbol) and a keymap definition would be a duplicate symbol / link error. Instead
  the keymap overrides `via_command_kb()` and returns `true` for our packets. This is exactly
  what `keymap.c` does via `#ifdef VIA_ENABLE`.
- Historical note: old QMK trees (e.g. tag `0.12.0`) had a `raw_hid_receive_kb()` hook with a
  `void` return and a "DO NOT call `raw_hid_send()`" rule; current master has no such symbol.
  This firmware targets current master.
- Our packets always start with `0x53` ('S'); VIA command ids are `0x01..0x15`. Packets
  without our magic byte return `false` / are ignored silently, so VIA and this module can
  share the single RAW HID interface.

**Typing hook.** `quantum/keyboard.c` defines the sanctioned weak per-loop hook:

```c
__attribute__((weak)) void housekeeping_task_user(void) {}
...
void housekeeping_task(void) {
    housekeeping_task_modules();
    housekeeping_task_kb();
    housekeeping_task_user();
}
```

**Context note (important, and slightly different from the original assumption).** Current
master calls the receive hook from the **main loop**, not from a USB interrupt:
`quantum/main.c` runs `raw_hid_task()` then `housekeeping_task()` each iteration, and
`tmk_core/protocol/chibios/usb_main.c` does:

```c
void raw_hid_task(void) {
    uint8_t buffer[RAW_EPSIZE];
    while (receive_report(USB_ENDPOINT_OUT_RAW, buffer, sizeof(buffer))) {
        raw_hid_receive(buffer, sizeof(buffer));
    }
}
```

The module is still written strictly split — receive hook parses/replies/enqueues only, all
key registration happens in `housekeeping_task_user()` — because that is the required
protocol design, it is what VIA itself effectively assumes, and it stays correct on QMK
versions/ports where the receive hook really can run in interrupt context (the queue is a
`volatile` single-producer/single-consumer ring buffer, and the producer never touches the
keyboard report).

**Board files.** `keyboards/gmmk/gmmk2/p96/ansi/keyboard.json` exists (`info.json` only at
the `p96/` level); there is no board-level `rules.mk`. `keymap.c` mirrors the real
`keymaps/default/keymap.c` (same `LAYOUT(...)` macro and argument order) and keeps both
layers, so it compiles like the stock keymap. `keyboards/gmmk/gmmk2/p96/ansi/readme.md`
documents the bootloader entry (below).

## Wire protocol (frozen)

Every report is exactly 32 bytes. Host → device: byte 0 is always `0x53` ('S').

| `data[1]` | Command | Payload                                  | Reply |
| --------- | ------- | ---------------------------------------- | ----- |
| `0x01`    | PING    | rest zero                                | PONG |
| `0x02`    | CONFIG  | `data[2]`=press_ms (clamped 2..200), `data[3]`=gap_ms (clamped 1..200) | CONFIG_ACK |
| `0x03`    | TEXT    | `data[2]`=len (1..29), `data[3..3+len)`=bytes | PONG; NACK(3) bad len/byte; NACK(2) not enough free queue slots (nothing enqueued) |
| `0x04`    | CLEAR   | —                                        | PONG (queue emptied, held key released) |
| other     | —       | —                                        | NACK(1) unknown command |
| `data[0]` ≠ `0x53` | — | —                                   | ignored silently (VIA etc.) |

Allowed TEXT bytes: `0x09` (Tab), `0x0A` (newline), `0x20..0x7E`. Anything else → NACK(3).

Device → host:

| Reply      | Bytes                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| PONG       | `[0]=0x53 [1]=0x81 [2]=1` (protocol version) `[3]=queue_len & 0xFF [4]=queue_len >> 8 [5]=typing_state` (0 idle, 1 pressing a key, 2 gap between keys), rest 0 |
| CONFIG_ACK | `[0]=0x53 [1]=0x82 [2]=press_ms [3]=gap_ms`, rest 0                     |
| NACK       | `[0]=0x53 [1]=0x83 [2]=code` (1 unknown command, 2 queue full, 3 unsupported byte/content, 4 reserved — CONFIG clamps instead of rejecting) `[3]=queue_len & 0xFF [4]=queue_len >> 8`, rest 0 |

Queue and timing: 512 usable bytes (single-producer/single-consumer ring buffer, full
capacity — no wasted slot); defaults press_ms=8, gap_ms=18 (one character every ≈26 ms,
i.e. ≈38 chars/s before per-loop overhead); each byte is pressed for press_ms, released,
then gap_ms elapses before the next one.

ASCII mapping: US ANSI. `0x0A` → `KC_ENTER` (no shift), `0x09` → `KC_TAB`. Letters, digits
and punctuation map to their US-layout keycodes; uppercase letters and the shifted symbols
`! " # $ % & ( ) * + : < > @ ^ _ { | } ~` add `KC_LSFT` to the HID report's modifier byte
via `add_mods(MOD_BIT(KC_LSFT))`. The complete 95-entry table (`0x20..0x7E`) is
`ascii_keys[]` in `screen_typing.c`.

## Build & flash

From a QMK checkout with the CLI installed (QMK MSYS on Windows):

```sh
# 1. copy this folder into the board's keymaps directory
cp -r firmware/gmmk2-96 <qmk_firmware>/keyboards/gmmk/gmmk2/p96/ansi/keymaps/screen_typing

# 2. build, then flash
qmk compile -kb gmmk/gmmk2/p96/ansi -km screen_typing
qmk flash   -kb gmmk/gmmk2/p96/ansi -km screen_typing
```

Legacy `make` equivalent (as in the board readme): `make gmmk/gmmk2/p96/ansi:screen_typing`
and `make gmmk/gmmk2/p96/ansi:screen_typing:flash`.

Bootloader entry (per the board readme): hold the Escape key while plugging in USB (this
also erases persistent settings), or hold the Reset pin under the spacebar while plugging
in, or press Fn+Backslash (the default Fn layer has `QK_BOOT` on the top-left key).
`qmk flash` drives the `wb32-dfu` bootloader via the `wb32-dfu-updater_cli` helper
(verified in `lib/python/qmk/flashers.py`); install QMK MSYS with the WB32 DFU tools or
QMK will tell you the tool is missing. See https://docs.qmk.fm/newbs_flashing.

## How to verify

1. Flash, open Notepad, click into it.
2. Send a flow with any RAW HID library (the app, or e.g. Python `hid` with
   VID `0x320F`, PID `0x504B`, usage page `0xFF60`, usage `0x61`):

```python
import hid
dev = next(d for d in hid.enumerate(0x320F, 0x504B)
           if d['usage_page'] == 0xFF60 and d['usage'] == 0x61)
h = hid.Device(path=dev['path'])

def send(payload):                      # payload <= 32 bytes
    h.write(bytes([0x00] + payload + [0] * (32 - len(payload))))  # 0x00 = report id
    return h.read(32, timeout=1000)

print(send([0x53, 0x01]))                       # PING -> PONG
print(send([0x53, 0x03, 5] + list(b'hello')))   # TEXT "hello" -> PONG
print(send([0x53, 0x04]))                       # CLEAR -> PONG
```

3. Expect: `hello` appearing in Notepad, typed slowly (≈38 chars/s by default), and
   PONG/NACK replies as in the table. Use PONG's queue length for flow control; on NACK(2)
   wait for the queue to drain and resend.

## Known limits

- US ANSI layout only. No IME, no compose/dead keys, no Unicode — non-ASCII never reaches
  the keyboard (the host app must transliterate or drop it).
- Newline is typed as `KC_ENTER` ("send" in chat UIs); there is no separate CR/LF choice.
- Typing interleaves with manual keys; if a human holds Shift while the module releases its
  own shift, the human's modifier can be cleared mid-press. Don't type on the board while
  the app streams.
- Fixed cadence, configurable 2..200 ms press / 1..200 ms gap; fastest cadence is 3 ms
  per character (press=2, gap=1), minus real per-loop and USB overheads — hosts should
  still pace themselves.
- 29 bytes max per TEXT report; larger text must be chunked. Queue is 512 bytes; overflow is
  reported (NACK 2), never silently dropped.
- If you enable `VIA_ENABLE = yes`, the same RAW HID interface is shared with VIA; the 0x53
  magic prevents collisions, but you are now shipping VIA's much larger attack surface too.
- The firmware only maps keys; it cannot control what the host app or OS does with them.

## Not compiled or tested here

**This firmware was NOT compiled or flashed in this environment** — no QMK toolchain is
available here (`qmk` CLI not found; no ARM GCC). Everything below is verified by reading
QMK master sources (cited above), and the keymap mirrors the board's in-tree default keymap,
but a real build/flash/hardware test is still required.

Unverified assumptions to check on the first real build:

1. Compilation of `screen_typing.c`/`keymap.c` for `wb32-dfu` (expected to work, not built here).
2. The `VIA_ENABLE = yes` variant (`via_command_kb` path) — logic verified by reading
   `quantum/via.c`, not compile-tested.
3. `qmk flash` + `wb32-dfu-updater_cli` on this Windows machine, and the USB DFU driver
   setup needed by the WB32 bootloader.
4. Runtime timing/NKRO behavior on hardware — `add_key`/`send_keyboard_report` semantics were
   verified by reading `tmk_core/protocol/report.c` and `quantum/action_util.c`, not on a device.

## Sources (fetched 2026-10-17, branch `master`)

- `quantum/raw_hid.c`, `quantum/raw_hid.h`, `quantum/via.c`, `quantum/via.h`
- `quantum/keyboard.c`, `quantum/main.c`, `tmk_core/protocol/chibios/usb_main.c`
- `quantum/action_util.h`, `quantum/action_util.c`, `tmk_core/protocol/report.c`, `quantum/keycode.h`, `platforms/timer.h`
- `builddefs/common_features.mk`, `builddefs/generic_features.mk`, `lib/python/qmk/flashers.py`
- `keyboards/gmmk/gmmk2/p96/ansi/keyboard.json`, `.../readme.md`, `.../keymaps/default/keymap.c`
- https://docs.qmk.fm/features/rawhid (usage page 0xFF60 / usage 0x61; 32-byte reports)
