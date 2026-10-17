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
//! | `0x02` | `[cmd, press_ms, gap_ms]` | `CONFIG` typing pace (firmware clamps to `2..=200` / `1..=200` and echoes it in `CONFIG_ACK`) |
//! | `0x03` | `[cmd, len, bytes...]` | `TEXT`, `1..=29` typable bytes: printable ASCII, `\t`, `\n`, and (from protocol version 2) the compensation opcodes `0x08` backspace / `0x7F` delete |
//! | `0x04` | `[cmd]` | `CLEAR` queued text (firmware replies `PONG`; the host does not wait for it) |
//!
//! Keyboard to host:
//!
//! | command | layout | meaning |
//! |---------|--------|---------|
//! | `0x81` | `[version, queue_lo, queue_hi, typing]` | `PONG`; `typing` is nonzero while a key phase is active |
//! | `0x82` | `[press_ms, gap_ms]` | `CONFIG_ACK` echoes the effective pace |
//! | `0x83` | `[code, queue_lo, queue_hi]` | `NACK`: `1` unknown command, `2` queue full, `3` bad text, `4` bad config (reserved; `CONFIG` clamps) |
//!
//! Device packets without the `0x53` marker are ignored silently because VIA
//! shares the same interface. A strict firmware replies to unknown `0x53`
//! packets with `NACK(unknown packet)`.

pub const REPORT_SIZE: usize = 32;
pub const MARKER: u8 = 0x53;
/// Maximum typable bytes in a single `TEXT` packet: `32 - 3` header bytes.
pub const MAX_TEXT_CHUNK: usize = 29;
/// Version reported by `PONG`; used to recognize our firmware during handshake.
/// Version 2 adds `0x08` (backspace) and `0x7F` (delete) to `TEXT` so
/// [`plan_typing`] can compensate for editor auto-indentation and auto-closing
/// brackets.
pub const FIRMWARE_VERSION: u8 = 2;

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
        if !(2..=200).contains(&self.press_ms) {
            return Err("Key press duration must be between 2 and 200 milliseconds");
        }
        if !(1..=200).contains(&self.gap_ms) {
            return Err("Typing gap must be between 1 and 200 milliseconds");
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
    QueueFull = 2,
    BadText = 3,
    BadConfig = 4,
}
impl NackCode {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::UnknownPacket),
            2 => Some(Self::QueueFull),
            3 => Some(Self::BadText),
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

/// Splits a [`plan_typing`] byte plan into `TEXT` packets of at most
/// [`MAX_TEXT_CHUNK`] bytes each. The plan alphabet was validated when the
/// plan was built, so only the packet size is enforced here.
pub fn plan_reports(plan: &[u8]) -> Result<Vec<[u8; REPORT_SIZE]>, TextError> {
    if plan.is_empty() {
        return Err(TextError::Empty);
    }
    Ok(plan.chunks(MAX_TEXT_CHUNK).map(build_text_report).collect())
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

// ---------------------------------------------------------------------------
// Typing plan
// ---------------------------------------------------------------------------

/// Language family of the answer being typed.
///
/// It only changes what Enter does: Python's language configuration indents
/// one level after a line that starts with a block keyword (`def`, `if`,
/// `for`, ...) and ends with `:`; C++ has no such rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypingLanguage {
    Python,
    Cpp,
}

impl TypingLanguage {
    /// Best-effort detection from the answer text itself; ties fall back to
    /// Python, the more common language in this workflow.
    pub fn detect(text: &str) -> Self {
        let mut python = 0i32;
        let mut cpp = 0i32;
        for line in text.lines() {
            let line = line.trim();
            if line.contains("#include")
                || line.contains("std::")
                || line.contains("using namespace")
            {
                cpp += 3;
            }
            if line.starts_with("import ")
                || line.starts_with("from ")
                || line.starts_with("def ")
                || (line.starts_with("class ") && line.ends_with(':'))
            {
                python += 3;
            }
            if line.ends_with(';') {
                cpp += 1;
            }
            if python_indent_line(line) {
                python += 2;
            }
        }
        if cpp > python {
            TypingLanguage::Cpp
        } else {
            TypingLanguage::Python
        }
    }
}

/// Mirrors the Python `onEnterRules` of Monaco's language configuration
/// (`^\s*(?:def|class|for|if|elif|else|while|try|with|finally|except|async|match|case).*?:\s*$`):
/// once trailing whitespace is stripped this means "begins with one of the
/// keywords and ends with a colon". Matching is a plain prefix test without a
/// word boundary, exactly like the regexp.
fn python_indent_line(line: &str) -> bool {
    const KEYWORDS: [&str; 14] = [
        "def", "class", "for", "if", "elif", "else", "while", "try", "with", "finally", "except",
        "async", "match", "case",
    ];
    let line = line.trim_start();
    line.ends_with(':') && KEYWORDS.iter().any(|kw| line.starts_with(kw))
}

/// One auto-closing pair the editor inserted while the plan was typed.
#[derive(Clone, Copy, Debug)]
struct PendingRider {
    /// Auto-inserted closing character.
    close: u8,
    /// Leading whitespace (columns) of the line that holds the opener. This is
    /// where an Enter expansion parks the rider and what the editor uses when
    /// a line starting with the closer is dedented.
    lead: usize,
    /// True once an Enter expansion parked the rider as the first content of
    /// its own line (preceded by `lead` spaces). Riders of a nested opener
    /// parked on the same line stay false and become current once the one in
    /// front of them is removed.
    parked: bool,
}

/// One indent level the editor inserts (Monaco `tabSize: 4`, spaces).
const INDENT_UNIT: usize = 4;
/// Compensation opcodes available with protocol version 2.
const BS_OPCODE: u8 = 0x08;
const DEL_OPCODE: u8 = 0x7f;

fn open_pair_close(c: u8) -> Option<u8> {
    match c {
        b'{' => Some(b'}'),
        b'[' => Some(b']'),
        b'(' => Some(b')'),
        _ => None,
    }
}

fn push_repeated(out: &mut Vec<u8>, byte: u8, count: usize) {
    out.resize(out.len() + count, byte);
}

/// Builds the byte plan that reproduces `text` when typed into a Monaco editor
/// (the LeetCode sheet) with default options.
///
/// `text` must already be normalized with [`normalize_for_typing`]. The plan
/// assumes the cursor sits on a cleared sheet, so clear the editor before the
/// first byte is sent.
///
/// Monaco reacts to plain typing in ways that would corrupt a verbatim answer:
///
/// * Enter keeps the current line's indentation; after a line that ends with
///   an open bracket (its auto-inserted closer sits right behind the cursor)
///   it expands to `\n + indent + unit + \n + indent`, and Python's
///   configuration adds one unit after a block keyword line ending in `:`.
/// * Every typed open bracket `{`, `[`, `(` gets its closer inserted right
///   behind the cursor.
/// * A closer typed as the first non-whitespace character of a line rewrites
///   the leading whitespace to the matching opener's indentation.
///
/// The plan tracks every auto-inserted closer and emits `0x08` backspace and
/// `0x7F` delete compensation at the right moments so the final buffer
/// matches `text` exactly.
pub fn plan_typing(text: &str, lang: TypingLanguage) -> Result<Vec<u8>, TextError> {
    if text.is_empty() {
        return Err(TextError::Empty);
    }
    let expanded = text.replace('\t', "    ");
    let mut lines: Vec<(usize, &str)> = Vec::new();
    for line in expanded.split('\n') {
        let trimmed = line.trim_end();
        if let Some(c) = trimmed.chars().find(|c| !(' '..='~').contains(c)) {
            return Err(TextError::Unsupported(c));
        }
        let lead = trimmed.len() - trimmed.trim_start_matches(' ').len();
        lines.push((lead, &trimmed[lead..]));
    }

    let mut out = Vec::with_capacity(text.len() + 16);
    let mut stack: Vec<PendingRider> = Vec::new();
    let mut doc_lead = 0usize;
    let last_line = lines.len() - 1;

    for (index, &(src_lead, content)) in lines.iter().enumerate() {
        // Settle the fresh line's indentation on the source's target.
        if src_lead > doc_lead {
            push_repeated(&mut out, b' ', src_lead - doc_lead);
        } else {
            push_repeated(&mut out, BS_OPCODE, doc_lead - src_lead);
        }
        let mut line_lead = src_lead;
        let mut first_char = true;

        for c in content.bytes() {
            match c {
                b'{' | b'[' | b'(' => {
                    stack.push(PendingRider {
                        close: open_pair_close(c).expect("matched above"),
                        lead: line_lead,
                        parked: false,
                    });
                    out.push(c);
                }
                b'}' | b']' | b')' => {
                    if stack.last().is_some_and(|r| r.close == c) {
                        let rider = stack.pop().expect("checked above");
                        if rider.parked {
                            // The closer dedents the fresh line to the
                            // opener's indentation; then join the parked line
                            // up and delete `lead` spaces plus the rider.
                            out.push(c);
                            if first_char {
                                line_lead = rider.lead;
                            }
                            push_repeated(&mut out, DEL_OPCODE, rider.lead + 2);
                        } else {
                            // The rider sits directly at the cursor: remove it
                            // first so inserting the closer stays
                            // deterministic in every cursor position.
                            push_repeated(&mut out, DEL_OPCODE, 1);
                            out.push(c);
                            if first_char {
                                line_lead = rider.lead;
                            }
                        }
                    } else {
                        // Unmatched closer: plain insert, like the editor.
                        out.push(c);
                    }
                }
                other => out.push(other),
            }
            first_char = false;
        }

        if index < last_line {
            out.push(b'\n');
            let expansion = content
                .as_bytes()
                .last()
                .and_then(|c| open_pair_close(*c))
                .is_some_and(|close| stack.last().is_some_and(|r| !r.parked && r.close == close));
            if expansion {
                // IndentOutdent: the rider parks on its own line below, and
                // the new cursor line receives one extra indent level.
                stack.last_mut().expect("checked above").parked = true;
                doc_lead = line_lead + INDENT_UNIT;
            } else if lang == TypingLanguage::Python && python_indent_line(content) {
                doc_lead = line_lead + INDENT_UNIT;
            } else {
                doc_lead = line_lead;
            }
        }
    }

    // Remove riders the text never consumed (unmatched or unfinished code).
    while let Some(rider) = stack.pop() {
        if rider.parked {
            push_repeated(&mut out, DEL_OPCODE, rider.lead + 2);
        } else {
            push_repeated(&mut out, DEL_OPCODE, 1);
        }
    }

    Ok(out)
}

/// Bytes the keyboard can type: printable ASCII, `\t`, `\n`, plus the two
/// compensation opcodes `0x08` (backspace) and `0x7F` (delete) that
/// [`plan_typing`] may emit; the latter two need firmware protocol version 2.
fn is_typable(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{8}' | '\u{7f}') || (' '..='~').contains(&c)
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
        assert!(text_report("\u{8}\u{7f}").is_ok());
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
                version: FIRMWARE_VERSION,
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
        assert!(TypingTimings { press_ms: 1, gap_ms: 18 }.validate().is_err());
        assert!(TypingTimings { press_ms: 201, gap_ms: 18 }.validate().is_err());
        assert!(TypingTimings { press_ms: 200, gap_ms: 200 }.validate().is_ok());
        assert!(TypingTimings { press_ms: 2, gap_ms: 1 }.validate().is_ok());
        assert!(TypingTimings { press_ms: 8, gap_ms: 0 }.validate().is_err());
        assert!(TypingTimings { press_ms: 8, gap_ms: 201 }.validate().is_err());
    }

    #[test]
    fn nack_codes_pin_the_frozen_wire_contract() {
        assert_eq!(NackCode::UnknownPacket as u8, 1);
        assert_eq!(NackCode::QueueFull as u8, 2);
        assert_eq!(NackCode::BadText as u8, 3);
        assert_eq!(NackCode::BadConfig as u8, 4);
        assert_eq!(NackCode::from_u8(3), Some(NackCode::BadText));
        assert_eq!(NackCode::from_u8(5), None);
    }

    #[test]
    fn error_messages_mention_the_limits() {
        assert!(TextError::Empty.message().contains("nothing"));
        assert!(TextError::TooLong { len: 40 }.message().contains("29"));
        assert!(TextError::Unsupported('\u{4e2d}').message().contains("ASCII"));
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;

    /// Minimal model of the Monaco behaviors [`plan_typing`] compensates for.
    /// Every rule mirrors a behavior verified against the real editor:
    /// auto-closing pairs insert together, Enter keeps the line indentation
    /// (with the Python block rule and the IndentOutdent expansion), and a
    /// closer typed as the first non-whitespace character rewrites the
    /// leading whitespace to the matching opener's indentation.
    #[derive(Default)]
    struct Sim {
        buf: Vec<char>,
        cursor: usize,
    }

    impl Sim {
        fn text(&self) -> String {
            self.buf.iter().collect()
        }

        fn line_start(&self) -> usize {
            self.buf[..self.cursor]
                .iter()
                .rposition(|c| *c == '\n')
                .map_or(0, |i| i + 1)
        }

        fn lead(&self) -> usize {
            let start = self.line_start();
            self.buf[start..self.cursor]
                .iter()
                .take_while(|c| **c == ' ')
                .count()
        }

        fn insert(&mut self, text: &str) {
            for (offset, c) in text.chars().enumerate() {
                self.buf.insert(self.cursor + offset, c);
            }
            self.cursor += text.chars().count();
        }

        fn enter(&mut self, lang: TypingLanguage) {
            let start = self.line_start();
            let before: String = self.buf[start..self.cursor].iter().collect();
            let before = before.trim_end();
            let lead = self.lead();
            let expansion = before
                .chars()
                .last()
                .map(|c| c as u8)
                .and_then(open_pair_close)
                .is_some_and(|close| self.buf.get(self.cursor) == Some(&(close as char)));
            if expansion {
                // The cursor lands on the middle line, after its indent.
                let indent = format!("\n{0}    \n{0}", " ".repeat(lead));
                self.insert(&indent);
                self.cursor -= lead + 1;
            } else if lang == TypingLanguage::Python && python_indent_line(before) {
                self.insert(&format!("\n{}    ", " ".repeat(lead)));
            } else {
                self.insert(&format!("\n{}", " ".repeat(lead)));
            }
        }

        fn type_char(&mut self, c: char) {
            if let Some(close) = open_pair_close(c as u8) {
                self.insert(&format!("{}{}", c, close as char));
                self.cursor -= 1;
                return;
            }
            if matches!(c, '}' | ']' | ')') && self.is_first_non_whitespace() {
                if let Some(opener) = self.matching_opener(c) {
                    let opener_line_start = self.buf[..opener]
                        .iter()
                        .rposition(|ch| *ch == '\n')
                        .map_or(0, |i| i + 1);
                    let lead = self.buf[opener_line_start..]
                        .iter()
                        .take_while(|ch| **ch == ' ')
                        .count();
                    let start = self.line_start();
                    self.buf.drain(start..self.cursor);
                    self.cursor = start;
                    self.insert(&format!("{}{}", " ".repeat(lead), c));
                    return;
                }
            }
            self.insert(&c.to_string());
        }

        fn is_first_non_whitespace(&self) -> bool {
            let start = self.line_start();
            self.buf[start..self.cursor].iter().all(|c| *c == ' ')
        }

        /// Pairs the closer with the nearest unmatched opener before the
        /// cursor, scanning backwards just like the observed editor.
        fn matching_opener(&self, close: char) -> Option<usize> {
            let open = match close {
                ')' => '(',
                ']' => '[',
                '}' => '{',
                _ => return None,
            };
            let mut depth = 0usize;
            for index in (0..self.cursor).rev() {
                let c = self.buf[index];
                if c == close {
                    depth += 1;
                } else if c == open {
                    if depth == 0 {
                        return Some(index);
                    }
                    depth -= 1;
                }
            }
            None
        }

        fn run(&mut self, plan: &[u8], lang: TypingLanguage) {
            for &b in plan {
                match b {
                    BS_OPCODE => {
                        if self.cursor > 0 {
                            self.cursor -= 1;
                            self.buf.remove(self.cursor);
                        }
                    }
                    DEL_OPCODE => {
                        if self.cursor < self.buf.len() {
                            self.buf.remove(self.cursor);
                        }
                    }
                    b'\n' => self.enter(lang),
                    other => self.type_char(other as char),
                }
            }
        }
    }

    fn roundtrip(source: &str, lang: TypingLanguage) -> String {
        let text = normalize_for_typing(source);
        let plan = plan_typing(&text, lang).expect("plan");
        let mut sim = Sim::default();
        sim.run(&plan, lang);
        sim.text()
    }

    #[test]
    fn plan_reproduces_flat_text() {
        for lang in [TypingLanguage::Python, TypingLanguage::Cpp] {
            assert_eq!(roundtrip("a\nb", lang), "a\nb");
            assert_eq!(roundtrip("x = 1\ny = 2\n", lang), "x = 1\ny = 2\n");
        }
    }

    #[test]
    fn plan_reproduces_python_solution() {
        let source = "class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, num in enumerate(nums):\n            if target - num in seen:\n                return [seen[target - num], i]\n            seen[num] = i\n        return []\n";
        assert_eq!(
            roundtrip(source, TypingLanguage::Python),
            normalize_for_typing(source)
        );
    }

    #[test]
    fn plan_reproduces_cpp_solution() {
        // `case 1:` must not receive the Python block-keyword indent; a wrong
        // language guess would misindent the return statement.
        let source = "#include <vector>\n\nclass Solution {\npublic:\n    bool can(int x) {\n        switch (x) {\n        case 1:\n            return true;\n        }\n        return false;\n    }\n};\n";
        assert_eq!(
            roundtrip(source, TypingLanguage::Cpp),
            normalize_for_typing(source)
        );
    }

    #[test]
    fn plan_reproduces_indented_dedent_payloads() {
        let cpp = "class A {\nif (k) {\nx\n}\ny\n}\nz\n";
        assert_eq!(roundtrip(cpp, TypingLanguage::Cpp), normalize_for_typing(cpp));
        let python = "z0\nif q:\nz1\nd = foo(\nz3\n)\nz4\n";
        assert_eq!(
            roundtrip(python, TypingLanguage::Python),
            normalize_for_typing(python)
        );
    }

    #[test]
    fn plan_reproduces_standard_continuation_style() {
        let python = "def f(x):\n    return foo(\n        x,\n        x,\n    )\n";
        assert_eq!(
            roundtrip(python, TypingLanguage::Python),
            normalize_for_typing(python)
        );
    }

    #[test]
    fn plan_removes_unconsumed_riders() {
        for (source, lang) in [
            ("if (k) {", TypingLanguage::Cpp),
            ("foo(bar(", TypingLanguage::Cpp),
            ("def f():", TypingLanguage::Python),
            ("x = [\n    1,\n", TypingLanguage::Python),
        ] {
            assert_eq!(
                roundtrip(source, lang),
                normalize_for_typing(source),
                "source: {source:?}"
            );
        }
    }

    #[test]
    fn plan_rejects_untypable_input() {
        assert_eq!(plan_typing("", TypingLanguage::Python), Err(TextError::Empty));
        assert_eq!(
            plan_typing("caf\u{e9}", TypingLanguage::Python),
            Err(TextError::Unsupported('\u{e9}'))
        );
    }

    #[test]
    fn languages_are_detected_from_the_answer() {
        assert_eq!(
            TypingLanguage::detect("class Solution:\n    def twoSum(self, nums, target):\n        pass\n"),
            TypingLanguage::Python
        );
        assert_eq!(
            TypingLanguage::detect("#include <vector>\nint main() {\n    return 0;\n}\n"),
            TypingLanguage::Cpp
        );
    }

    #[test]
    fn plan_bytes_stay_within_the_wire_alphabet() {
        let source = "class Solution:\n    def f(self):\n        return {1: [2]}\n";
        let plan = plan_typing(&normalize_for_typing(source), TypingLanguage::Python).unwrap();
        assert!(plan.iter().all(|b| matches!(b, 0x08 | 0x7f | b'\n') || (b' '..=b'~').contains(b)));
        assert!(text_reports(std::str::from_utf8(&plan).unwrap()).is_ok());
    }
}
