/*
 * Copyright 2026 The screen-typing firmware authors
 * Keymap derived from keyboards/gmmk/gmmk2/p96/ansi/keymaps/default/keymap.c
 * (Copyright 2021 Glorious, LLC <salman@pcgamingrace.com>).
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
 * Screen-typing keymap for the Glorious GMMK 2 96% ANSI
 * (keyboard id: gmmk/gmmk2/p96/ansi).
 *
 * Base and Fn layers mirror the board's real default keymap. On top of that,
 * this keymap wires up the screen_typing module:
 *
 *   - keyboard_post_init_user()  initialises the module,
 *   - housekeeping_task_user()   drives the non-blocking typing engine,
 *   - raw_hid_receive() / via_command_kb()  receive 32-byte RAW HID reports
 *     from the host (VIA disabled / enabled respectively — see below).
 *
 * The keyboard emits real HID keyboard reports for every byte the host
 * streams. That input is automated, not human-originated; see README.md.
 */

#include QMK_KEYBOARD_H

#include "raw_hid.h" // declares raw_hid_receive(), so the override below is signature-checked
#include "screen_typing.h"

// Each layer gets a name for readability, which is then used in the keymap matrix below.
// The underscores don't mean anything - you can have a layer called STUFF or any other name.
enum custom_layers {
    _BL,
    _FL,
};

const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {
  /* Keymap _BL: Base Layer (Default Layer)
   */
[_BL] = LAYOUT(
  QK_GESC,  KC_F1,    KC_F2,    KC_F3,    KC_F4,    KC_F5,    KC_F6,    KC_F7,    KC_F8,    KC_F9,    KC_F10,   KC_F11,   KC_F12,   KC_PSCR,  KC_DEL,   KC_INS,   KC_PGUP,  KC_PGDN,
  KC_GRV,   KC_1,     KC_2,     KC_3,     KC_4,     KC_5,     KC_6,     KC_7,     KC_8,     KC_9,     KC_0,     KC_MINS,  KC_EQL,   KC_BSPC,  KC_NUM,   KC_PSLS,  KC_PAST,  KC_PMNS,
  KC_TAB,   KC_Q,     KC_W,     KC_E,     KC_R,     KC_T,     KC_Y,     KC_U,     KC_I,     KC_O,     KC_P,     KC_LBRC,  KC_RBRC,  KC_BSLS,  KC_P7,    KC_P8,    KC_P9,    KC_PPLS,
  KC_CAPS,  KC_A,     KC_S,     KC_D,     KC_F,     KC_G,     KC_H,     KC_J,     KC_K,     KC_L,     KC_SCLN,  KC_QUOT,            KC_ENT,   KC_P4,    KC_P5,    KC_P6,
  KC_LSFT,  KC_Z,     KC_X,     KC_C,     KC_V,     KC_B,     KC_N,     KC_M,     KC_COMM,  KC_DOT,   KC_SLSH,  KC_RSFT,  KC_UP,    KC_P1,    KC_P2,    KC_P3,    KC_PENT,
  KC_LCTL,  KC_LGUI,  KC_LALT,                      KC_SPC,                                 KC_RALT,  MO(_FL),  KC_RCTL,  KC_LEFT,  KC_DOWN,  KC_RGHT,  KC_P0,    KC_PDOT),

  /* Keymap _FL: Function Layer
   */
[_FL] = LAYOUT(
  QK_BOOT,  KC_MYCM,  KC_WHOM,  KC_CALC,  KC_MSEL,  KC_MPRV,  KC_MRWD,  KC_MPLY,  KC_MSTP,  KC_MUTE,  KC_VOLD,  KC_VOLU,  _______,   _______,  _______,  _______,  _______,  _______,
  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,   _______,  _______,  _______,  _______,  _______,
  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,   _______,  _______,  _______,  _______,  _______,
  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,             _______,  _______,  _______,
  _______,  RM_HUEU,  RM_HUED,  RM_SPDD,  RM_SPDU,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  RM_VALU,   _______,  _______,  _______,  _______,
  _______,  UC_WIN,   _______,                      _______,                                _______,  _______,  _______,  RM_PREV,   RM_VALD,  RM_NEXT,  _______,  _______)
};

/* ---------------------------------------------------------------------------
 * Screen-typing integration
 * ------------------------------------------------------------------------- */

/** Called once after QMK finishes initialising. */
void keyboard_post_init_user(void) {
    screen_typing_init();
}

/**
 * Runs once per main-loop iteration; drives the non-blocking typing engine.
 *
 * housekeeping_task_user() is the QMK-sanctioned weak hook for per-loop
 * keymap-level work (quantum/keyboard.c: "Override this function if you have
 * a need to execute code for every keyboard main loop iteration").
 */
void housekeeping_task_user(void) {
    screen_typing_task();
}

/*
 * RAW HID receive path.
 *
 * Without VIA, quantum/raw_hid.c defines raw_hid_receive() as a weak symbol,
 * so overriding it here is the documented pattern (docs.qmk.fm/features/rawhid).
 *
 * With VIA_ENABLE = yes, quantum/via.c defines a *strong* raw_hid_receive()
 * (which first forwards to the weak via_command_kb()), so defining
 * raw_hid_receive() here as well would be a duplicate symbol at link time.
 * In that configuration the keymap must override via_command_kb() instead:
 * return true means "packet fully handled, including any raw_hid_send()".
 *
 * Our protocol packets always start with 0x53 ('S'), which never collides
 * with VIA command ids (0x01..0x15). Packets without that magic byte are
 * left alone, so VIA keeps working normally alongside this module.
 */
#ifdef VIA_ENABLE
bool via_command_kb(uint8_t *data, uint8_t length) {
    return screen_typing_handle_packet(data, length);
}
#else
void raw_hid_receive(uint8_t *data, uint8_t length) {
    (void)screen_typing_handle_packet(data, length);
}
#endif
