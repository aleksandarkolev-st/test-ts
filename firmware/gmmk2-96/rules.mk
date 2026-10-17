# Screen-typing keymap build options.
#
# Enables the RAW HID interface (HID usage page 0xFF60 / usage 0x61, see
# docs.qmk.fm/features/rawhid) and compiles the screen_typing module that
# sits next to this keymap. Extra .c files in a keymap directory are not
# picked up automatically, hence the explicit SRC line.

RAW_ENABLE = yes
SRC += screen_typing.c

# VIA interaction (verified against QMK master, 2026-10-17):
#
# - VIA_ENABLE = yes implies RAW_ENABLE = yes (builddefs/common_features.mk)
#   and compiles quantum/via.c, which provides a *strong* raw_hid_receive().
#   Defining raw_hid_receive() in keymap.c in that configuration would be a
#   duplicate symbol at link time.
# - keymap.c therefore defines raw_hid_receive() only when VIA is disabled,
#   and overrides the weak via_command_kb() hook when it is enabled.
# - This module's 0x53 ('S') magic byte never collides with VIA command ids
#   (0x01..0x15), so both protocols can share the interface safely.
#
# Uncomment the next line to build with VIA support; the code adapts.
# VIA_ENABLE = yes
