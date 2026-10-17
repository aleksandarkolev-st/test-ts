//! Opt-in screen monitoring: periodic captures are analyzed by the vision model
//! ([`service`], [`vision`]), and the resulting answer can be typed through a
//! QMK RAW HID keyboard bridge once fresh evidence confirms focus. Policy,
//! caching, and eligibility rules live in [`crate::attachments::screen_monitor`];
//! this module implements the transport ([`protocol`]), the hardware client that
//! speaks it ([`hid`]), and foreground application identity ([`foreground`]).
pub mod foreground;
pub mod hid;
pub mod protocol;
pub mod service;
pub mod typing;
pub mod vision;
