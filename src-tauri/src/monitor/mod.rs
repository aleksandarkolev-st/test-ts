//! Opt-in screen monitoring: periodic captures are analyzed by the vision model,
//! and the resulting answer can be typed through a QMK RAW HID keyboard bridge
//! once fresh evidence confirms focus. Policy, caching, and eligibility rules
//! live in [`crate::attachments::screen_monitor`]; this module implements the
//! transport ([`protocol`]) and the hardware client that speaks it.
pub mod hid;
pub mod protocol;
