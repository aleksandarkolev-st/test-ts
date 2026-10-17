//! Frozen host/firmware wire protocol for the QMK RAW HID typing bridge.
//!
//! Every packet is a 32-byte report on vendor usage page `0xFF60` / usage `0x61`
//! (`RAW_EPSIZE` on the keyboard) whose first byte is always the marker `0x53`
//! (`'S'` for screen typing). The Windows HID stack prepends a report ID byte on
//! the wire; this module only deals with the 32-byte payload QMK sees.
//!
//! Host to keyboard:
//!
//! | command | layout | meaning |
//! |---------|--------|---------|
//! | `0x01` | `[cmd]` | `PING` |
//! | `0x02` | `[cmd, press_ms, gap_ms]` | `CONFIG` typing pace |
//! | `0x03` | `[cmd, len, bytes...]` | `TEXT`, `1..=29` typable ASCII bytes |
//! | `0x04` | `[cmd]` | `CLEAR` queued text |
//!
//! Keyboard to host:
//!
//! | command | layout | meaning |
//! |---------|--------|---------|
//! | `0x81` | `[version, queue_lo, queue_hi, typing]` | `PONG` |
//! | `0x82` | `[]` | `CONFIG_ACK` |
//! | `0x83` | `[code, queue_lo, queue_hi]` | `NACK` |
//!
//! Device packets without the `0x53` marker are ignored silently because VIA
//! shares the same interface. A strict firmware replies to unknown `0x53`
//! packets with `NACK(unknown packet)`.

pub const REPORT_SIZE: usize = 32;
pub const MARKER: u8 = 0x53;
/// Maximum typable bytes in a single `TEXT` packet: `32 - 3` header bytes.
pub const MAX_TEXT_CHUNK: usize = 29;
/// Version reported by `PONG`; used to recognize our firmware during handshake.
pub const FIRMWARE_VERSION: u8 = 1;

pub const CMD_PING: u8 = 0x01;
pub const CMD_CONFIG: u8 = 0x02;
pub const CMD_TEXT: u8 = 0x03;
pub const CMD_CLEAR: u8 = 0x04;
pub const CMD_PONG: u8 = 0x81;
pub const CMD_CONFIG_ACK: u8 = 0x82;
pub const CMD_NACK: u8 = 0x83;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TypingTimings {
    pub press_ms: u8,
    pub gap_ms: u8,
}
impl Default for TypingTimings {
    fn default() -> Self {
        Self {
            press_ms: 8,
            gap_ms: 18,
        }
    }
}
impl TypingTimings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=50).contains(&self.press_ms) {
            return Err("Key press duration must be between 1 and 50 milliseconds");
        }
        if !(1..=250).contains(&self.gap_ms) {
            return Err("Typing gap must be between 1 and 250 milliseconds");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypingSpeed {
    Slow,
    Normal,
    Fast,
}
impl TypingSpeed {
    pub fn from_setting(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "slow" => Some(Self::Slow),
            "normal" => Some(Self::Normal),
            "fast" => Some(Self::Fast),
            _ => None,
        }
    }
    pub const fn as_setting(self) -> &'static str {
        match self {
            Self::Slow => "slow",
            Self::Normal => "normal",
            Self::Fast => "fast",
        }
    }
    pub const fn timings(self) -> TypingTimings {
        match self {
            Self::Slow => TypingTimings {
                press_ms: 12,
                gap_ms: 40,
            },
            Self::Normal => TypingTimings {
                press_ms: 8,
                gap_ms: 18,
            },
            Self::Fast => TypingTimings {
                press_ms: 4,
                gap_ms: 8,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NackCode {
    UnknownPacket = 1,
    BadText = 2,
    QueueFull = 3,
    BadConfig = 4,
}
impl NackCode {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::UnknownPacket),
            2 => Some(Self::BadText),
            3 => Some(Self::QueueFull),
            4 => Some(Self::BadConfig),
            _ => None,
        }
    }
    pub const fn description(self) -> &'static str {
        match self {
            Self::UnknownPacket => "keyboard rejected an unknown packet",
            Self::BadText => "keyboard rejected a text chunk",
            Self::QueueFull => "keyboard queue is full",
            Self::BadConfig => "keyboard rejected the typing pace",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Inbound {
    Pong {
        version: u8,
        queue_len: u16,
        typing: bool,
    },
    ConfigAck,
    Nack {
        code: NackCode,
        queue_len: u16,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseError {
    WrongSize { len: usize },
    UnknownCommand(u8),
    UnknownNackCode(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextError {
    Empty,
    TooLong { len: usize },
    Unsupported(char),
}
impl TextError {
    pub fn message(self) -> String {
        match self {
            Self::Empty => "There is nothing to type".into(),
            Self::TooLong { len } => {
                format!("A single typing chunk cannot exceed {MAX_TEXT_CHUNK} bytes (got {len})")
            }
            Self::Unsupported(c) => format!(
                "The keyboard cannot type {:?}; only tab, newline, and printable ASCII are supported",
                c
            ),
        }
    }
}

pub fn ping_report() -> [u8; REPORT_SIZE] {
    let mut report = [0u8; REPORT_SIZE];
    report[0] = MARKER;
    report[1] = CMD_PING;
    report
}

pub fn config_report(timings: TypingTimings) -> [u8; REPORT_SIZE] {
    debug_assert!(timings.validate().is_ok());
    let mut report = [0u8; REPORT_SIZE];
    report[0] = MARKER;
    report[1] = CMD_CONFIG;
    report[2] = timings.press_ms;
    report[3] = timings.gap_ms;
    report
}

pub fn clear_report() -> [u8; REPORT_SIZE] {
    let mut report = [0u8; REPORT_SIZE];
    report[0] = MARKER;
    report[1] = CMD_CLEAR;
    report
}

/// Encodes exactly one `TEXT` chunk of `1..=29` typable ASCII bytes.
pub fn text_report(chunk: &str) -> Result<[u8; REPORT_SIZE], TextError> {
    let bytes = chunk.as_bytes();
    if bytes.is_empty() {
        return Err(TextError::Empty);
    }
    if bytes.len() > MAX_TEXT_CHUNK {
        return Err(TextError::TooLong { len: bytes.len() });
    }
    if let Some(c) = chunk.chars().find(|c| !is_typable(*c)) {
        return Err(TextError::Unsupported(c));
    }
    Ok(build_text_report(bytes))
}

/// Splits `text` into `TEXT` packets of at most [`MAX_TEXT_CHUNK`] bytes each.
/// Callers should run [`normalize_for_typing`] first so common Unicode
/// punctuation is transliterated instead of rejected.
pub fn text_reports(text: &str) -> Result<Vec<[u8; REPORT_SIZE]>, TextError> {
    if text.is_empty() {
        return Err(TextError::Empty);
    }
    if let Some(c) = text.chars().find(|c| !is_typable(*c)) {
        return Err(TextError::Unsupported(c));
    }
    Ok(text
        .as_bytes()
        .chunks(MAX_TEXT_CHUNK)
        .map(build_text_report)
        .collect())
}

fn build_text_report(chunk: &[u8]) -> [u8; REPORT_SIZE] {
    debug_assert!(!chunk.is_empty() && chunk.len() <= MAX_TEXT_CHUNK);
    let mut report = [0u8; REPORT_SIZE];
    report[0] = MARKER;
    report[1] = CMD_TEXT;
    report[2] = chunk.len() as u8;
    report[3..3 + chunk.len()].copy_from_slice(chunk);
    report
}

/// Transliterates characters a US ANSI keyboard cannot type directly and
/// normalizes line endings. Characters without a mapping are preserved and are
/// later rejected by [`text_reports`], keeping the failure explicit.
pub fn normalize_for_typing(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\u{00A0}' | '\u{2007}' | '\u{2009}' | '\u{202F}' => out.push(' '),
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => out.push('\''),
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => out.push('"'),
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => out.push('-'),
            '\u{2026}' => out.push_str("..."),
            '\u{2022}' | '\u{00B7}' | '\u{25AA}' | '\u{25A0}' | '\u{25CF}' => out.push('*'),
            '\u{00D7}' => out.push('x'),
            '\u{00F7}' => out.push('/'),
            '\u{2264}' => out.push_str("<="),
            '\u{2265}' => out.push_str(">="),
            '\u{2260}' => out.push_str("!="),
            '\u{2248}' => out.push_str("~="),
            '\u{2190}' => out.push_str("<-"),
            '\u{2192}' => out.push_str("->"),
            other => out.push(other),
        }
    }
    out
}

fn is_typable(c: char) -> bool {
    matches!(c, '\t' | '\n') || (' '..='~').contains(&c)
}

/// Parses one 32-byte payload read from the keyboard. Returns `Ok(None)` for
/// foreign traffic without our marker (VIA shares the interface).
pub fn parse_reply(report: &[u8]) -> Result<Option<Inbound>, ParseError> {
    if report.first() != Some(&MARKER) {
        return Ok(None);
    }
    if report.len() != REPORT_SIZE {
        return Err(ParseError::WrongSize { len: report.len() });
    }
    match report[1] {
        CMD_PONG => Ok(Some(Inbound::Pong {
            version: report[2],
            queue_len: u16::from_le_bytes([report[3], report[4]]),
            typing: report[5] != 0,
        })),
        CMD_CONFIG_ACK => Ok(Some(Inbound::ConfigAck)),
        CMD_NACK => match NackCode::from_u8(report[2]) {
            Some(code) => Ok(Some(Inbound::Nack {
                code,
                queue_len: u16::from_le_bytes([report[3], report[4]]),
            })),
            None => Err(ParseError::UnknownNackCode(report[2])),
        },
        other => Err(ParseError::UnknownCommand(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_packets_use_the_frozen_layout() {
        let ping = ping_report();
        assert_eq!(ping[0], MARKER);
        assert_eq!(ping[1], CMD_PING);
        assert!(ping[2..].iter().all(|&b| b == 0));

        let config = config_report(TypingTimings {
            press_ms: 12,
            gap_ms: 40,
        });
        assert_eq!(&config[..4], &[MARKER, CMD_CONFIG, 12, 40]);
        assert!(config[4..].iter().all(|&b| b == 0));

        let clear = clear_report();
        assert_eq!(&clear[..2], &[MARKER, CMD_CLEAR]);
        assert!(clear[2..].iter().all(|&b| b == 0));
    }

    #[test]
    fn text_packet_carries_length_prefixed_ascii() {
        let report = text_report("hello\tworld\n").unwrap();
        assert_eq!(report[0], MARKER);
        assert_eq!(report[1], CMD_TEXT);
        assert_eq!(report[2], 12);
        assert_eq!(&report[3..15], b"hello\tworld\n");
        assert!(report[15..].iter().all(|&b| b == 0));
    }

    #[test]
    fn text_packet_rejects_empty_oversized_and_untypable_input() {
        assert_eq!(text_report(""), Err(TextError::Empty));
        assert_eq!(
            text_report(&"a".repeat(30)),
            Err(TextError::TooLong { len: 30 })
        );
        assert_eq!(
            text_report("caf\u{e9}"),
            Err(TextError::Unsupported('\u{e9}'))
        );
        assert_eq!(text_report("bell\u{7}"), Err(TextError::Unsupported('\u{7}')));
        assert_eq!(
            text_report("del\u{7f}"),
            Err(TextError::Unsupported('\u{7f}'))
        );
        assert!(text_report(&"a".repeat(29)).is_ok());
    }

    #[test]
    fn long_text_is_split_into_full_chunks() {
        let text = "ab".repeat(30);
        let reports = text_reports(&text).unwrap();
        assert_eq!(reports.len(), 3);
        assert_eq!(reports[0][2], 29);
        assert_eq!(&reports[0][3..32], &text.as_bytes()[..29]);
        assert_eq!(reports[1][2], 29);
        assert_eq!(&reports[1][3..32], &text.as_bytes()[29..58]);
        assert_eq!(reports[2][2], 2);
        assert_eq!(&reports[2][3..5], &text.as_bytes()[58..]);
        assert!(reports.iter().all(|r| r[0] == MARKER && r[1] == CMD_TEXT));
    }

    #[test]
    fn empty_text_has_no_packets() {
        assert_eq!(text_reports(""), Err(TextError::Empty));
    }

    #[test]
    fn replies_are_parsed_field_by_field() {
        let pong = [
            MARKER, CMD_PONG, FIRMWARE_VERSION, 0x10, 0x02, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(
            parse_reply(&pong),
            Ok(Some(Inbound::Pong {
                version: 1,
                queue_len: 0x0210,
                typing: true,
            }))
        );

        let mut ack = [0u8; REPORT_SIZE];
        ack[0] = MARKER;
        ack[1] = CMD_CONFIG_ACK;
        assert_eq!(parse_reply(&ack), Ok(Some(Inbound::ConfigAck)));

        let mut nack = [0u8; REPORT_SIZE];
        nack[0] = MARKER;
        nack[1] = CMD_NACK;
        nack[2] = NackCode::QueueFull as u8;
        nack[3] = 0xFF;
        nack[4] = 0x01;
        assert_eq!(
            parse_reply(&nack),
            Ok(Some(Inbound::Nack {
                code: NackCode::QueueFull,
                queue_len: 0x01FF,
            }))
        );
        assert!(NackCode::UnknownPacket.description().contains("unknown"));
    }

    #[test]
    fn foreign_and_malformed_replies_are_handled() {
        // VIA traffic: no marker, ignored silently.
        assert_eq!(parse_reply(&[0x00, 0x01, 0x02]), Ok(None));
        assert_eq!(parse_reply(&[]), Ok(None));

        // Marker present but the report is not 32 bytes: protocol error.
        assert_eq!(
            parse_reply(&[MARKER, CMD_PONG, 1]),
            Err(ParseError::WrongSize { len: 3 })
        );

        let mut unknown = [0u8; REPORT_SIZE];
        unknown[0] = MARKER;
        unknown[1] = 0x99;
        assert_eq!(parse_reply(&unknown), Err(ParseError::UnknownCommand(0x99)));

        let mut bad_nack = [0u8; REPORT_SIZE];
        bad_nack[0] = MARKER;
        bad_nack[1] = CMD_NACK;
        bad_nack[2] = 9;
        assert_eq!(parse_reply(&bad_nack), Err(ParseError::UnknownNackCode(9)));
    }

    #[test]
    fn unicode_punctuation_is_transliterated_before_typing() {
        let input = "He said \u{201c}hi\u{201d}\u{2014}then left\u{2026}\r\nsegue\rx\u{00A0}y \u{2264} z";
        let normalized = normalize_for_typing(input);
        assert_eq!(normalized, "He said \"hi\"-then left...\nsegue\nx y <= z");
        let reports = text_reports(&normalized).unwrap();
        assert_eq!(reports.len(), 2);
    }

    #[test]
    fn unmapped_unicode_still_fails_explicitly() {
        let normalized = normalize_for_typing("caf\u{e9}");
        assert_eq!(
            text_reports(&normalized),
            Err(TextError::Unsupported('\u{e9}'))
        );
    }

    #[test]
    fn typing_speeds_map_to_frozen_timings() {
        assert_eq!(
            TypingSpeed::from_setting(" Slow "),
            Some(TypingSpeed::Slow)
        );
        assert_eq!(TypingSpeed::from_setting("FAST"), Some(TypingSpeed::Fast));
        assert_eq!(TypingSpeed::from_setting("turbo"), None);
        assert_eq!(TypingSpeed::Slow.as_setting(), "slow");
        assert_eq!(TypingSpeed::Normal.as_setting(), "normal");
        assert_eq!(TypingSpeed::Fast.as_setting(), "fast");
        assert_eq!(TypingSpeed::Slow.timings(), TypingTimings { press_ms: 12, gap_ms: 40 });
        assert_eq!(TypingSpeed::Fast.timings(), TypingTimings { press_ms: 4, gap_ms: 8 });
        assert!(TypingSpeed::Normal.timings().validate().is_ok());
        assert!(TypingTimings::default().validate().is_ok());
    }

    #[test]
    fn out_of_range_timings_are_rejected() {
        assert!(TypingTimings { press_ms: 0, gap_ms: 18 }.validate().is_err());
        assert!(TypingTimings { press_ms: 51, gap_ms: 18 }.validate().is_err());
        assert!(TypingTimings { press_ms: 8, gap_ms: 0 }.validate().is_err());
        assert!(TypingTimings { press_ms: 8, gap_ms: 251 }.validate().is_err());
    }

    #[test]
    fn error_messages_mention_the_limits() {
        assert!(TextError::Empty.message().contains("nothing"));
        assert!(TextError::TooLong { len: 40 }.message().contains("29"));
        assert!(TextError::Unsupported('\u{4e2d}').message().contains("ASCII"));
    }
}
