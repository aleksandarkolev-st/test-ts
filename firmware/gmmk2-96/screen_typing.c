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
 * Screen typing over RAW HID — implementation.
 *
 * The host application streams answer text to the keyboard as 32-byte RAW
 * HID reports (usage page 0xFF60, usage 0x61). This module turns that stream
 * into real HID keyboard reports that the keyboard itself emits, so the
 * keystrokes originate from the keyboard's USB device rather than from a
 * synthetic SendInput call on Windows.
 *
 * This is still automated input: not human typing, not claimed to be
 * undetectable. See README.md for the honest description.
 *
 * Design / context notes (verified against QMK master, 2026-10-17):
 *
 * - The receive hook (screen_typing_handle_packet) is called from
 *   raw_hid_receive() when VIA is disabled, or from via_command_kb() when
 *   VIA is enabled (quantum/via.c defines a strong raw_hid_receive(), so a
 *   keymap must not define that symbol in a VIA build). The hook ONLY parses,
 *   replies and enqueues. It never registers or unregisters keys, so it is
 *   safe no matter which context QMK calls it from.
 *
 * - All typing happens from screen_typing_task(), driven by
 *   housekeeping_task_user() once per main-loop iteration.
 *
 * - On current QMK master the receive hook itself runs from the main loop
 *   (quantum/main.c calls raw_hid_task() which calls raw_hid_receive()).
 *   The queue below is nevertheless written as a single-producer /
 *   single-consumer ring buffer with volatile indices, so it also stays
 *   correct on QMK versions/platforms where the receive hook runs in USB
 *   interrupt context.
 */

#include "screen_typing.h"

#include <string.h>

#include "quantum.h"
#include "raw_hid.h"
#include "timer.h"

/* The ring buffer mask below requires a power-of-two capacity. */
STATIC_ASSERT((SCREEN_TYPING_QUEUE_SIZE & (SCREEN_TYPING_QUEUE_SIZE - 1)) == 0, "SCREEN_TYPING_QUEUE_SIZE must be a power of two");

/* --------------------------------------------------------------------------
 * Ring buffer
 *
 * - `queue_head` and `queue_drop` are written exclusively by the receive
 *   hook (producer side).
 * - `queue_tail` is written exclusively by screen_typing_task() (consumer).
 *
 * The indices are free-running uint16_t counters; `head - tail` (mod 2^16)
 * is the number of used bytes because enqueue refuses to exceed
 * SCREEN_TYPING_QUEUE_SIZE. That gives the full 512 bytes of usable
 * capacity. `queue_drop` implements CLEAR without the producer having to
 * touch `queue_tail`: a CLEAR has already logically dropped everything up to
 * `queue_drop`, and the consumer advances its tail there on its next run.
 * ------------------------------------------------------------------------ */

static volatile uint8_t  queue_buf[SCREEN_TYPING_QUEUE_SIZE];
static volatile uint16_t queue_head; /* next write position              */
static volatile uint16_t queue_tail; /* next read position               */
static volatile uint16_t queue_drop; /* CLEAR watermark, consumer skips to it */

/* --------------------------------------------------------------------------
 * Configuration and typing state
 * ------------------------------------------------------------------------ */

/* Defaults per protocol: press 8 ms, gap 18 ms until a CONFIG arrives. */
static volatile uint16_t press_ms = SCREEN_TYPING_DEFAULT_PRESS_MS;
static volatile uint16_t gap_ms   = SCREEN_TYPING_DEFAULT_GAP_MS;

/* State machine; values match the typing_state byte carried in PONG. */
static volatile uint8_t typing_state    = SCREEN_TYPING_STATE_IDLE;
static volatile bool    clear_requested = false;

/* Currently held key. Only ever touched from screen_typing_task(). */
static uint8_t  current_key;
static bool     current_shift;
static uint16_t phase_timer; /* press or gap phase start time */

/* --------------------------------------------------------------------------
 * Queue helpers
 * ------------------------------------------------------------------------ */

/**
 * Effective number of queued bytes, i.e. what the consumer will still type.
 *
 * A pending CLEAR (queue_drop written by the producer) is already accounted
 * for, so the caller sees the same value the consumer will see after it has
 * skipped to the watermark. The comparison below is safe under uint16_t
 * wrap-around: the distance between the indices is bounded by the queue
 * capacity (512), while a "stale" watermark behind the tail wraps to a large
 * unsigned value.
 */
static uint16_t queue_len(void) {
    uint16_t head = queue_head;
    uint16_t tail = queue_tail;
    uint16_t drop = queue_drop;

    if ((uint16_t)(drop - tail) <= (uint16_t)(head - tail)) {
        /* The consumer is going to skip forward to `drop`; the drop
         * watermark is the authoritative read position. */
        tail = drop;
    }
    return (uint16_t)(head - tail);
}

/**
 * Append `len` bytes to the ring buffer.
 *
 * Returns false (and enqueues nothing) when fewer than `len` slots are free.
 * Only ever called from the receive hook.
 */
static bool queue_enqueue(const uint8_t *bytes, uint8_t len) {
    uint16_t free_slots = (uint16_t)(SCREEN_TYPING_QUEUE_SIZE - queue_len());
    if (free_slots < len) {
        return false;
    }

    uint16_t head = queue_head;
    for (uint8_t i = 0; i < len; i++) {
        queue_buf[(uint16_t)(head + i) & (SCREEN_TYPING_QUEUE_SIZE - 1)] = bytes[i];
    }

    /* Publish the new data with a single 16-bit store. */
    queue_head = (uint16_t)(head + len);
    return true;
}

/* --------------------------------------------------------------------------
 * Replies (device -> host)
 * ------------------------------------------------------------------------ */

/** Zero a reply buffer and fill in the magic byte and reply id. */
static void reply_begin(uint8_t *resp, uint8_t reply_id) {
    memset(resp, 0, SCREEN_TYPING_REPORT_SIZE);
    resp[0] = SCREEN_TYPING_MAGIC;
    resp[1] = reply_id;
}

/**
 * PONG: [2]=protocol version, [3..4]=queue_len little-endian,
 * [5]=typing_state, rest zero. Also sent as the acknowledgement for PING,
 * TEXT (success) and CLEAR.
 */
static void send_pong(void) {
    uint16_t len  = queue_len();
    uint8_t  resp[SCREEN_TYPING_REPORT_SIZE];
    reply_begin(resp, SCREEN_TYPING_REPLY_PONG);
    resp[2] = SCREEN_TYPING_PROTOCOL_VERSION;
    resp[3] = (uint8_t)(len & 0xFF);
    resp[4] = (uint8_t)(len >> 8);
    resp[5] = typing_state;
    raw_hid_send(resp, sizeof(resp));
}

/** CONFIG_ACK: [2]=effective press_ms, [3]=effective gap_ms, rest zero. */
static void send_config_ack(void) {
    uint8_t resp[SCREEN_TYPING_REPORT_SIZE];
    reply_begin(resp, SCREEN_TYPING_REPLY_CONFIG_ACK);
    resp[2] = (uint8_t)press_ms;
    resp[3] = (uint8_t)gap_ms;
    raw_hid_send(resp, sizeof(resp));
}

/**
 * NACK: [2]=code (enum screen_typing_nack),
 * [3..4]=queue_len little-endian, rest zero.
 */
static void send_nack(uint8_t code) {
    uint16_t len = queue_len();
    uint8_t  resp[SCREEN_TYPING_REPORT_SIZE];
    reply_begin(resp, SCREEN_TYPING_REPLY_NACK);
    resp[2] = code;
    resp[3] = (uint8_t)(len & 0xFF);
    resp[4] = (uint8_t)(len >> 8);
    raw_hid_send(resp, sizeof(resp));
}

/* --------------------------------------------------------------------------
 * ASCII -> HID keycode table (US ANSI)
 *
 * One entry for every byte in 0x20..0x7E, indexed by (byte - 0x20). `keycode`
 * is the unmodified HID keycode; `shift` says whether KC_LSFT must be held.
 * KC_LSFT is added with add_mods(MOD_BIT(KC_LSFT)), which lands in the HID
 * report's modifier byte (application code never adds modifiers to the
 * keys[] array — the HID spec reserves that range).
 *
 * 0x08 (Backspace), 0x09 (Tab), 0x0A (newline/Enter) and 0x7F (Delete) are
 * handled separately in press_ascii() and are not part of this table.
 *
 * The table is `const`, so on ARM/ChibiOS it lives in flash; no PROGMEM
 * needed (PROGMEM is a no-op outside AVR anyway).
 * ------------------------------------------------------------------------ */

typedef struct {
    uint8_t keycode; /* Basic HID keycode.               */
    bool    shift;   /* True if it needs the Left Shift. */
} ascii_key_t;

// clang-format off
static const ascii_key_t ascii_keys[] = {
    /* 0x20 ' '       0x21 '!'        0x22 '"'        0x23 '#'        0x24 '$'        0x25 '%'        0x26 '&'    0x27 '\''        0x28 '('        0x29 ')' */
    {KC_SPC, false}, {KC_1, true}, {KC_QUOT, true}, {KC_3, true}, {KC_4, true}, {KC_5, true}, {KC_7, true}, {KC_QUOT, false}, {KC_9, true}, {KC_0, true},
    /* 0x2A '*'       0x2B '+'        0x2C ','        0x2D '-'        0x2E '.'        0x2F '/'        0x30 '0'     0x31 '1'        0x32 '2'        0x33 '3' */
    {KC_8, true}, {KC_EQL, true}, {KC_COMM, false}, {KC_MINS, false}, {KC_DOT, false}, {KC_SLSH, false}, {KC_0, false}, {KC_1, false}, {KC_2, false}, {KC_3, false},
    /* 0x34 '4'       0x35 '5'        0x36 '6'        0x37 '7'        0x38 '8'        0x39 '9'        0x3A ':'     0x3B ';'        0x3C '<'        0x3D '=' */
    {KC_4, false}, {KC_5, false}, {KC_6, false}, {KC_7, false}, {KC_8, false}, {KC_9, false}, {KC_SCLN, true}, {KC_SCLN, false}, {KC_COMM, true}, {KC_EQL, false},
    /* 0x3E '>'       0x3F '?'        0x40 '@'        0x41 'A'        0x42 'B'        0x43 'C'        0x44 'D'    0x45 'E'        0x46 'F'        0x47 'G' */
    {KC_DOT, true}, {KC_SLSH, true}, {KC_2, true}, {KC_A, true}, {KC_B, true}, {KC_C, true}, {KC_D, true}, {KC_E, true}, {KC_F, true}, {KC_G, true},
    /* 0x48 'H'       0x49 'I'        0x4A 'J'        0x4B 'K'        0x4C 'L'        0x4D 'M'        0x4E 'N'    0x4F 'O'        0x50 'P'        0x51 'Q' */
    {KC_H, true}, {KC_I, true}, {KC_J, true}, {KC_K, true}, {KC_L, true}, {KC_M, true}, {KC_N, true}, {KC_O, true}, {KC_P, true}, {KC_Q, true},
    /* 0x52 'R'       0x53 'S'        0x54 'T'        0x55 'U'        0x56 'V'        0x57 'W'        0x58 'X'    0x59 'Y'        0x5A 'Z'        0x5B '[' */
    {KC_R, true}, {KC_S, true}, {KC_T, true}, {KC_U, true}, {KC_V, true}, {KC_W, true}, {KC_X, true}, {KC_Y, true}, {KC_Z, true}, {KC_LBRC, false},
    /* 0x5C '\\'      0x5D ']'        0x5E '^'        0x5F '_'        0x60 '`'        0x61 'a'        0x62 'b'    0x63 'c'        0x64 'd'        0x65 'e' */
    {KC_BSLS, false}, {KC_RBRC, false}, {KC_6, true}, {KC_MINS, true}, {KC_GRV, false}, {KC_A, false}, {KC_B, false}, {KC_C, false}, {KC_D, false}, {KC_E, false},
    /* 0x66 'f'       0x67 'g'        0x68 'h'        0x69 'i'        0x6A 'j'        0x6B 'k'        0x6C 'l'    0x6D 'm'        0x6E 'n'        0x6F 'o' */
    {KC_F, false}, {KC_G, false}, {KC_H, false}, {KC_I, false}, {KC_J, false}, {KC_K, false}, {KC_L, false}, {KC_M, false}, {KC_N, false}, {KC_O, false},
    /* 0x70 'p'       0x71 'q'        0x72 'r'        0x73 's'        0x74 't'        0x75 'u'        0x76 'v'    0x77 'w'        0x78 'x'        0x79 'y' */
    {KC_P, false}, {KC_Q, false}, {KC_R, false}, {KC_S, false}, {KC_T, false}, {KC_U, false}, {KC_V, false}, {KC_W, false}, {KC_X, false}, {KC_Y, false},
    /* 0x7A 'z'       0x7B '{'        0x7C '|'        0x7D '}'        0x7E '~' */
    {KC_Z, false}, {KC_LBRC, true}, {KC_BSLS, true}, {KC_RBRC, true}, {KC_GRV, true},
};
// clang-format on

/* 0x20..0x7E inclusive */
STATIC_ASSERT(sizeof(ascii_keys) / sizeof(ascii_keys[0]) == 95, "ascii_keys must cover ASCII 0x20..0x7E");

/** Byte values accepted in a TEXT payload: backspace, Tab, newline, Delete,
 *  printable ASCII. 0x08 and 0x7F exist so the host can compensate for the
 *  editor's auto-indentation and auto-closing brackets (protocol version 2). */
static inline bool ascii_supported(uint8_t byte) {
    return byte == 0x08 || byte == 0x09 || byte == 0x0A || byte == 0x7F
           || (byte >= 0x20 && byte <= 0x7E);
}

/** Clamp a millisecond value into [lo, hi]. */
static inline uint16_t clamp_ms(uint16_t value, uint16_t lo, uint16_t hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

/* --------------------------------------------------------------------------
 * Typing engine (runs from screen_typing_task() only)
 * ------------------------------------------------------------------------ */

/**
 * Press the key for one queued byte: add the shift modifier if needed, add
 * the keycode to the (N)KRO report and push the report to the host.
 */
static void press_ascii(uint8_t byte) {
    current_shift = false;

    if (byte == 0x08) {
        /* Backspace, never shifted. */
        current_key = KC_BSPC;
    } else if (byte == 0x09) {
        /* Tab, never shifted. */
        current_key = KC_TAB;
    } else if (byte == 0x0A) {
        /* Newline is typed as Enter (please send), never shifted. */
        current_key = KC_ENTER;
    } else if (byte == 0x7F) {
        /* Delete, never shifted. */
        current_key = KC_DEL;
    } else if (byte >= 0x20 && byte <= 0x7E) {
        const ascii_key_t *entry = &ascii_keys[byte - 0x20];
        current_key              = entry->keycode;
        current_shift            = entry->shift;
    } else {
        /* Cannot happen: TEXT payloads are validated on receipt. */
        current_key = 0;
        return;
    }

    if (current_shift) {
        add_mods(MOD_BIT(KC_LSFT));
    }
    add_key(current_key);
    send_keyboard_report();
}

/**
 * Release the key that press_ascii() pressed, if any, and push the updated
 * report. Safe to call when nothing is held.
 */
static void release_current_key(void) {
    if (current_key == 0) {
        return;
    }
    del_key(current_key);
    if (current_shift) {
        del_mods(MOD_BIT(KC_LSFT));
    }
    send_keyboard_report();
    current_key   = 0;
    current_shift = false;
}

/* --------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------ */

void screen_typing_init(void) {
    queue_head = queue_tail = queue_drop = 0;
    press_ms                     = SCREEN_TYPING_DEFAULT_PRESS_MS;
    gap_ms                       = SCREEN_TYPING_DEFAULT_GAP_MS;
    typing_state                 = SCREEN_TYPING_STATE_IDLE;
    clear_requested              = false;
    current_key                  = 0;
    current_shift                = false;
    phase_timer                  = 0;
}

void screen_typing_task(void) {
    /* Fast path: idle, nothing queued, no clear pending. */
    if (!clear_requested && typing_state == SCREEN_TYPING_STATE_IDLE && queue_tail == queue_head) {
        return;
    }

    /*
     * CLEAR processing: release whatever key is held and skip the read
     * pointer to the producer's drop watermark. This runs at most one
     * main-loop iteration after the CLEAR report arrived; the reply was
     * already sent by the receive hook.
     */
    if (clear_requested) {
        clear_requested = false;
        release_current_key();
        queue_tail   = queue_drop;
        typing_state = SCREEN_TYPING_STATE_IDLE;
    }

    /* Drive the current press/gap phase. */
    switch (typing_state) {
        case SCREEN_TYPING_STATE_PRESS:
            if (timer_elapsed(phase_timer) >= press_ms) {
                release_current_key();
                typing_state = SCREEN_TYPING_STATE_GAP;
                phase_timer  = timer_read();
            }
            break;
        case SCREEN_TYPING_STATE_GAP:
            if (timer_elapsed(phase_timer) >= gap_ms) {
                typing_state = SCREEN_TYPING_STATE_IDLE;
            }
            break;
        default:
            break;
    }

    /* Start the next key once idle again. */
    if (typing_state == SCREEN_TYPING_STATE_IDLE && queue_tail != queue_head) {
        uint16_t tail = queue_tail;
        uint8_t  byte = queue_buf[tail & (SCREEN_TYPING_QUEUE_SIZE - 1)];
        queue_tail    = (uint16_t)(tail + 1);

        press_ascii(byte);
        typing_state = SCREEN_TYPING_STATE_PRESS;
        phase_timer  = timer_read();
    }
}

bool screen_typing_handle_packet(uint8_t *data, uint8_t length) {
    /* Foreign protocols (e.g. VIA) share this interface: ignore silently. */
    if (length < SCREEN_TYPING_REPORT_SIZE || data[0] != SCREEN_TYPING_MAGIC) {
        return false;
    }

    switch (data[1]) {
        case SCREEN_TYPING_CMD_PING:
            send_pong();
            break;

        case SCREEN_TYPING_CMD_CONFIG:
            /* Out-of-range values are clamped, so NACK(4) is never sent. */
            press_ms = clamp_ms(data[2], SCREEN_TYPING_MIN_PRESS_MS, SCREEN_TYPING_MAX_PRESS_MS);
            gap_ms   = clamp_ms(data[3], SCREEN_TYPING_MIN_GAP_MS, SCREEN_TYPING_MAX_GAP_MS);
            send_config_ack();
            break;

        case SCREEN_TYPING_CMD_TEXT: {
            uint8_t len = data[2];
            if (len == 0 || len > SCREEN_TYPING_MAX_TEXT_LEN) {
                send_nack(SCREEN_TYPING_NACK_BAD_CONTENT);
                break;
            }

            bool supported = true;
            for (uint8_t i = 0; i < len; i++) {
                if (!ascii_supported(data[3 + i])) {
                    supported = false;
                    break;
                }
            }
            if (!supported) {
                send_nack(SCREEN_TYPING_NACK_BAD_CONTENT);
                break;
            }

            if (!queue_enqueue(&data[3], len)) {
                send_nack(SCREEN_TYPING_NACK_QUEUE_FULL);
                break;
            }

            send_pong();
            break;
        }

        case SCREEN_TYPING_CMD_CLEAR:
            /*
             * Logically drop everything enqueued so far by moving the drop
             * watermark (never touch queue_tail here — the consumer owns it).
             * The task releases the held key on its next run. The PONG below
             * already reports queue_len 0 because queue_drop == queue_head.
             */
            queue_drop      = queue_head;
            clear_requested = true;
            send_pong();
            break;

        default:
            send_nack(SCREEN_TYPING_NACK_UNKNOWN_COMMAND);
            break;
    }

    return true;
}

uint16_t screen_typing_queue_len(void) {
    return queue_len();
}

uint8_t screen_typing_state(void) {
    return typing_state;
}
