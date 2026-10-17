/*
 * Copyright 2026 The screen-typing firmware authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Screen typing over RAW HID — public interface.
 *
 * A host application streams short ASCII chunks to the keyboard as 32-byte
 * RAW HID reports (HID usage page 0xFF60, usage 0x61). This module queues
 * them and types them out as real HID keyboard reports emitted by the
 * keyboard itself. This is automated input: it is not human typing and it
 * is not intended to be undetectable. See README.md for the full story.
 *
 * Wire protocol (all reports are exactly 32 bytes):
 *
 *   Host -> device (byte 0 is always SCREEN_TYPING_MAGIC == 'S'):
 *     0x01 PING   data[1]=0x01, rest zero          -> PONG
 *     0x02 CONFIG data[2]=press_ms, data[3]=gap_ms -> CONFIG_ACK
 *                 (clamped to 2..200 and 1..200)
 *     0x03 TEXT   data[2]=len (1..29),
 *                 data[3..3+len)=ASCII            -> PONG on success,
 *                 NACK(3) bad len/unsupported byte,
 *                 NACK(2) not enough queue space
 *     0x04 CLEAR  data[1]=0x04                     -> PONG (queue emptied)
 *     other 0x53 0xXX                              -> NACK(1)
 *     byte 0 != 'S'                                -> ignored silently
 *
 *   Device -> host:
 *     PONG       [0]=0x53 [1]=0x81 [2]=version [3..4]=queue_len (LE)
 *                [5]=typing state, rest zero
 *     CONFIG_ACK [0]=0x53 [1]=0x82 [2]=press_ms [3]=gap_ms, rest zero
 *     NACK       [0]=0x53 [1]=0x83 [2]=code [3..4]=queue_len (LE), rest zero
 *
 *   Only 0x09 (Tab), 0x0A (newline) and 0x20..0x7E are accepted in TEXT.
 *   The full ASCII -> HID keycode table lives in screen_typing.c.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Byte 0 of every host -> device packet (ASCII 'S'). */
#define SCREEN_TYPING_MAGIC 0x53

/* Protocol version reported in PONG byte 2. */
#define SCREEN_TYPING_PROTOCOL_VERSION 1

/* RAW HID reports are always this many bytes (RAW_EPSIZE in current QMK). */
#define SCREEN_TYPING_REPORT_SIZE 32

/* Host -> device command ids (data[1]). */
enum screen_typing_command {
    SCREEN_TYPING_CMD_PING   = 0x01,
    SCREEN_TYPING_CMD_CONFIG = 0x02,
    SCREEN_TYPING_CMD_TEXT   = 0x03,
    SCREEN_TYPING_CMD_CLEAR  = 0x04,
};

/* Device -> host reply ids (byte 1 of the reply). */
enum screen_typing_reply {
    SCREEN_TYPING_REPLY_PONG       = 0x81,
    SCREEN_TYPING_REPLY_CONFIG_ACK = 0x82,
    SCREEN_TYPING_REPLY_NACK       = 0x83,
};

/* NACK codes (byte 2 of a NACK reply). */
enum screen_typing_nack {
    SCREEN_TYPING_NACK_UNKNOWN_COMMAND = 1, /* unknown 0x53 command            */
    SCREEN_TYPING_NACK_QUEUE_FULL      = 2, /* not enough free queue slots     */
    SCREEN_TYPING_NACK_BAD_CONTENT     = 3, /* bad length / unsupported byte   */
    SCREEN_TYPING_NACK_BAD_CONFIG      = 4, /* reserved: CONFIG clamps instead */
};

/* Typing engine tuning, in milliseconds. */
#define SCREEN_TYPING_DEFAULT_PRESS_MS 8  /* key hold time before CONFIG      */
#define SCREEN_TYPING_DEFAULT_GAP_MS 18   /* pause between keys before CONFIG */
#define SCREEN_TYPING_MIN_PRESS_MS 2
#define SCREEN_TYPING_MAX_PRESS_MS 200
#define SCREEN_TYPING_MIN_GAP_MS 1
#define SCREEN_TYPING_MAX_GAP_MS 200

/* Longest TEXT payload accepted in a single report (32 - 3 header bytes). */
#define SCREEN_TYPING_MAX_TEXT_LEN 29

/* Usable capacity of the byte queue. Must be a power of two. */
#define SCREEN_TYPING_QUEUE_SIZE 512

/* Typing-engine states; also reported verbatim in PONG byte 5. */
enum screen_typing_state {
    SCREEN_TYPING_STATE_IDLE  = 0, /* nothing queued / gap before next key */
    SCREEN_TYPING_STATE_PRESS = 1, /* a key is currently pressed           */
    SCREEN_TYPING_STATE_GAP   = 2, /* key released, waiting before next    */
};

/* Reset the module (queue, config, state machine). Call once at boot. */
void screen_typing_init(void);

/*
 * Drive the non-blocking typing state machine. Call from
 * housekeeping_task_user() (the sanctioned per-main-loop weak hook,
 * declared in quantum/keyboard.c) so it runs outside the receive path.
 */
void screen_typing_task(void);

/*
 * Parse one 32-byte RAW HID report and act on it (reply and/or enqueue).
 *
 * Returns true when the packet used our magic byte (0x53) and was consumed,
 * false otherwise (in which case nothing is read, written or replied to, so
 * other protocols such as VIA can share the interface untouched).
 *
 * Call this from raw_hid_receive() (VIA disabled) or via_command_kb()
 * (VIA enabled) in the keymap — see keymap.c for why it must be one or the
 * other. Safe to call from the USB receive path: it only parses, replies and
 * enqueues; it never registers or unregisters keys.
 */
bool screen_typing_handle_packet(uint8_t *data, uint8_t length);

/* Number of queued bytes that have not been typed yet (debug/host use). */
uint16_t screen_typing_queue_len(void);

/* Current typing state (one of enum screen_typing_state). */
uint8_t screen_typing_state(void);
