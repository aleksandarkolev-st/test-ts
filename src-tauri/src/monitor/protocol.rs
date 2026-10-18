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

/// Encodes one already-planned byte group (`1..=29` bytes of a [`plan_typing`]
/// stream or a [`Performance`] segment) as a `TEXT` report; the alphabet was
/// validated when the plan or performance was built.
pub fn raw_text_report(bytes: &[u8]) -> Result<[u8; REPORT_SIZE], TextError> {
    if bytes.is_empty() {
        return Err(TextError::Empty);
    }
    if bytes.len() > MAX_TEXT_CHUNK {
        return Err(TextError::TooLong { len: bytes.len() });
    }
    Ok(build_text_report(bytes))
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

// ---------------------------------------------------------------------------
// Human performance
// ---------------------------------------------------------------------------

/// Parameters for a human-like typing performance.
///
/// The performance is app-side pacing only: the wire protocol and the firmware
/// are untouched. The typed bytes are the [`plan_typing`] plan plus
/// editor-neutral mistakes and second thoughts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HumanSpec {
    /// Wall-clock budget for the whole performance (lead-in + typing + pauses).
    pub target_ms: u64,
    /// Firmware milliseconds per typed byte (`press_ms + gap_ms`).
    pub per_byte_ms: u32,
    /// Seed for the deterministic RNG; identical seeds plan identical sessions.
    pub seed: u64,
}

/// One `TEXT` packet of a [`Performance`]: `1..=29` bytes held for
/// `pause_after_ms` before the next packet is sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerformanceSegment {
    pub bytes: Vec<u8>,
    pub pause_after_ms: u64,
}

/// A humanized typing session: one lead-in pause, then paced segments whose
/// concatenated bytes reproduce the answer exactly (the mistakes cancel out).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Performance {
    pub lead_pause_ms: u64,
    pub segments: Vec<PerformanceSegment>,
}

impl Performance {
    /// Total bytes the firmware has to type.
    pub fn typed_bytes(&self) -> usize {
        self.segments
            .iter()
            .map(|segment| segment.bytes.len())
            .sum()
    }
    /// Total wall-clock time: lead-in, firmware typing time, and every pause.
    pub fn total_ms(&self, per_byte_ms: u32) -> u64 {
        let typing = self.typed_bytes() as u64 * per_byte_ms as u64;
        let pauses: u64 = self
            .segments
            .iter()
            .map(|segment| segment.pause_after_ms)
            .sum();
        self.lead_pause_ms + typing + pauses
    }
}

/// Deterministic xorshift64* generator: a session must be reproducible from
/// its seed so tests can pin exact schedules.
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in `lo..=hi`.
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        debug_assert!(lo <= hi);
        lo + self.next() % (hi - lo + 1)
    }
    /// Rolls a percentage in `0..100`.
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// Longest single pause a scaled performance may contain.
const MAX_PAUSE_MS: u64 = 180_000;
/// Pauses shorter than this merge their neighboring segments.
const MIN_PAUSE_MS: u64 = 15;
/// Odds that a word boundary becomes a wrong-key slip.
const TYPO_CHANCE_PCT: u64 = 12;
/// Minimum distance between two wrong-key slips, in plan bytes.
const TYPO_MIN_GAP: usize = 24;
/// Odds that a word boundary becomes a second thought.
const SECOND_THOUGHT_CHANCE_PCT: u64 = 7;
/// Minimum distance between two second thoughts, in plan bytes.
const SECOND_THOUGHT_MIN_GAP: usize = 70;

/// Typing units of a plan. Pauses, mistakes, and second thoughts only ever
/// land on the boundaries between units, so the plan's compensation
/// bookkeeping stays untouched.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PieceKind {
    Word,
    Punct,
    Enter,
    Control,
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_control_byte(byte: u8) -> bool {
    byte == BS_OPCODE || byte == DEL_OPCODE
}

fn split_pieces(plan: &[u8]) -> Vec<(PieceKind, &[u8])> {
    let mut pieces = Vec::new();
    let mut start = 0usize;
    while start < plan.len() {
        let byte = plan[start];
        let kind = if is_control_byte(byte) {
            PieceKind::Control
        } else if byte == b'\n' {
            PieceKind::Enter
        } else if is_word_byte(byte) {
            PieceKind::Word
        } else {
            PieceKind::Punct
        };
        let mut end = start + 1;
        match kind {
            PieceKind::Enter => {}
            PieceKind::Control => {
                while end < plan.len() && is_control_byte(plan[end]) {
                    end += 1;
                }
            }
            PieceKind::Word => {
                while end < plan.len() && is_word_byte(plan[end]) {
                    end += 1;
                }
            }
            PieceKind::Punct => {
                while end < plan.len()
                    && !is_control_byte(plan[end])
                    && plan[end] != b'\n'
                    && !is_word_byte(plan[end])
                {
                    end += 1;
                }
            }
        }
        pieces.push((kind, &plan[start..end]));
        start = end;
    }
    pieces
}

/// A keyboard neighbour of `key`, preserving case: the "wrong key slipped in"
/// mistake. Always a plain letter, so the editor reacts to it like any other
/// keystroke.
fn key_neighbor(key: u8, rng: &mut Rng) -> u8 {
    let lower = key.to_ascii_lowercase();
    let neighbors: &[u8] = match lower {
        b'q' => b"wa",
        b'w' => b"qea",
        b'e' => b"wrd",
        b'r' => b"etf",
        b't' => b"ryg",
        b'y' => b"tuh",
        b'u' => b"yij",
        b'i' => b"uok",
        b'o' => b"ipl",
        b'p' => b"ol",
        b'a' => b"qsz",
        b's' => b"awd",
        b'd' => b"sef",
        b'f' => b"drg",
        b'g' => b"fth",
        b'h' => b"gyj",
        b'j' => b"huk",
        b'k' => b"jil",
        b'l' => b"kop",
        b'z' => b"ax",
        b'x' => b"zs",
        b'c' => b"xd",
        b'v' => b"cf",
        b'b' => b"vg",
        b'n' => b"bh",
        b'm' => b"nj",
        _ => b"asd",
    };
    let pick = neighbors[rng.range(0, neighbors.len() as u64 - 1) as usize];
    if key.is_ascii_uppercase() {
        pick.to_ascii_uppercase()
    } else {
        pick
    }
}

/// "Double mind" alternatives for common identifiers.
fn swapped_word(word: &str) -> Option<&'static str> {
    Some(match word.to_ascii_lowercase().as_str() {
        "result" | "res" => "ans",
        "ans" => "result",
        "count" | "cnt" => "total",
        "total" => "sum",
        "sum" => "count",
        "temp" => "tmp",
        "tmp" => "temp",
        "memo" => "cache",
        "cache" => "memo",
        "seen" => "visited",
        "visited" => "seen",
        "nums" => "arr",
        "arr" => "nums",
        "left" => "lo",
        "lo" => "left",
        "right" => "hi",
        "hi" => "right",
        "prev" => "last",
        "last" => "prev",
        "curr" => "cur",
        "cur" => "node",
        "node" => "cur",
        "val" => "num",
        "num" => "val",
        "idx" => "index",
        "index" => "idx",
        "ret" => "out",
        "target" => "goal",
        "goal" => "target",
        "low" => "start",
        "start" => "low",
        "end" => "stop",
        "stop" => "end",
        "best" => "maxv",
        "maxv" => "best",
        _ => return None,
    })
}

/// What the typist almost wrote instead: a known alternative name when the
/// word has one, otherwise a false start (`word` has at least two ASCII bytes).
fn second_thought(word: &str, rng: &mut Rng) -> String {
    if let Some(alternative) = swapped_word(word) {
        if word.as_bytes()[0].is_ascii_uppercase() {
            let mut alternative = alternative.to_string();
            alternative[..1].make_ascii_uppercase();
            return alternative;
        }
        return alternative.to_string();
    }
    let take = rng.range(1, (word.len() as u64 - 1).min(3)) as usize;
    word[..take].to_string()
}

/// Natural gap after `prev` before `cur`, in milliseconds before scaling.
fn natural_pause(prev: Option<PieceKind>, cur: PieceKind, rng: &mut Rng) -> u64 {
    match (prev, cur) {
        (Some(PieceKind::Enter), _) => rng.range(900, 3200),
        (Some(PieceKind::Control), _) => rng.range(150, 700),
        (_, PieceKind::Enter) => rng.range(250, 1100),
        (_, PieceKind::Word) => rng.range(120, 800),
        (Some(PieceKind::Word), _) => rng.range(40, 220),
        _ => rng.range(20, 120),
    }
}

/// Scales `pauses` so they sum to `budget`, pinning individual pauses at
/// [`MAX_PAUSE_MS`]; returns the sum actually placed (≤ `budget`).
fn scale_pauses(pauses: &mut [u64], budget: u64) -> u64 {
    let mut pinned = vec![false; pauses.len()];
    for _ in 0..6 {
        let total: u128 = pauses.iter().map(|pause| *pause as u128).sum();
        if total == 0 {
            return 0;
        }
        if total as u64 == budget {
            return budget;
        }
        if total as u64 > budget {
            // Scaling down never pushes a pause over the cap.
            for pause in pauses.iter_mut() {
                *pause = (*pause as u128 * budget as u128 / total) as u64;
            }
            return pauses.iter().sum();
        }
        let pinned_total: u128 = pauses
            .iter()
            .zip(&pinned)
            .filter(|(_, is_pinned)| **is_pinned)
            .map(|(pause, _)| *pause as u128)
            .sum();
        let fresh_total: u128 = pauses
            .iter()
            .zip(&pinned)
            .filter(|(_, is_pinned)| !**is_pinned)
            .map(|(pause, _)| *pause as u128)
            .sum();
        if fresh_total == 0 {
            return pinned_total as u64;
        }
        let remaining = budget as u128 - pinned_total;
        for (pause, is_pinned) in pauses.iter_mut().zip(pinned.iter_mut()) {
            if *is_pinned {
                continue;
            }
            let scaled = (*pause as u128 * remaining / fresh_total) as u64;
            if scaled >= MAX_PAUSE_MS {
                *pause = MAX_PAUSE_MS;
                *is_pinned = true;
            } else {
                *pause = scaled;
            }
        }
    }
    pauses.iter().sum()
}

/// One typing unit plus the pause that follows it (before scaling).
struct Atom {
    bytes: Vec<u8>,
    pause_after_ms: u64,
}

/// Builds a humanized performance for `text` (already normalized with
/// [`normalize_for_typing`]).
pub fn plan_performance(
    text: &str,
    lang: TypingLanguage,
    spec: HumanSpec,
) -> Result<Performance, TextError> {
    let plan = plan_typing(text, lang)?;
    Ok(humanize_plan(&plan, spec))
}

/// Wraps a [`plan_typing`] byte plan into a [`Performance`]: wrong-key slips
/// (a neighbouring key, a beat, then a backspace) and second thoughts (an
/// alternative name or a false start, deleted, then the real thing) are woven
/// between typing units, and every boundary gets a pause drawn from a natural
/// distribution and scaled so the session takes about `spec.target_ms`.
///
/// Both mistake styles insert plain letters and then remove them again, so the
/// cursor and the buffer return to exactly where the plan expects them: the
/// concatenated segment bytes still reproduce the answer.
pub fn humanize_plan(plan: &[u8], spec: HumanSpec) -> Performance {
    let mut rng = Rng::new(spec.seed);
    let pieces = split_pieces(plan);
    let mut atoms: Vec<Atom> = Vec::new();
    let mut position = 0usize;
    let mut last_typo: Option<usize> = None;
    let mut last_second_thought: Option<usize> = None;
    let mut prev_kind: Option<PieceKind> = None;

    let gap_ok = |last: Option<usize>, gap: usize, position: usize| {
        last.map_or(true, |last| position.saturating_sub(last) >= gap)
    };

    for (kind, bytes) in pieces {
        if kind == PieceKind::Word && bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() {
            if gap_ok(last_second_thought, SECOND_THOUGHT_MIN_GAP, position)
                && rng.chance(SECOND_THOUGHT_CHANCE_PCT)
            {
                let word = std::str::from_utf8(bytes).unwrap_or_default();
                let alternative = second_thought(word, &mut rng);
                let backspaces = vec![BS_OPCODE; alternative.len()];
                atoms.push(Atom {
                    bytes: alternative.into_bytes(),
                    pause_after_ms: rng.range(650, 2400),
                });
                atoms.push(Atom {
                    bytes: backspaces,
                    pause_after_ms: rng.range(300, 1300),
                });
                last_second_thought = Some(position);
            } else if gap_ok(last_typo, TYPO_MIN_GAP, position) && rng.chance(TYPO_CHANCE_PCT) {
                atoms.push(Atom {
                    bytes: vec![key_neighbor(bytes[0], &mut rng)],
                    pause_after_ms: rng.range(140, 620),
                });
                atoms.push(Atom {
                    bytes: vec![BS_OPCODE],
                    pause_after_ms: rng.range(60, 260),
                });
                last_typo = Some(position);
            }
        }
        atoms.push(Atom {
            bytes: bytes.to_vec(),
            pause_after_ms: natural_pause(prev_kind, kind, &mut rng),
        });
        prev_kind = Some(kind);
        position += bytes.len();
    }
    // The session is over once the last byte has landed: the trailing pause is
    // dropped before scaling so the budget lands on the visible typing.
    if let Some(last) = atoms.last_mut() {
        last.pause_after_ms = 0;
    }

    // Spread the remaining wall-clock budget over the natural pauses.
    let typed_bytes: usize = atoms.iter().map(|atom| atom.bytes.len()).sum();
    let typed_ms = typed_bytes as u64 * spec.per_byte_ms as u64;
    let lead = (spec.target_ms / 16).max(30);
    let mut pauses: Vec<u64> = atoms.iter().map(|atom| atom.pause_after_ms).collect();
    let pause_budget = spec
        .target_ms
        .saturating_sub(typed_ms)
        .saturating_sub(lead);
    let achieved = scale_pauses(&mut pauses, pause_budget);
    // Whatever the pause caps could not place (short answers with few
    // boundaries) becomes one long opening "reading the problem" pause.
    let lead = (lead + pause_budget.saturating_sub(achieved))
        .min(spec.target_ms.saturating_mul(9) / 10);

    let mut segments: Vec<PerformanceSegment> = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    for (atom, pause) in atoms.into_iter().zip(pauses) {
        let pause = if pause < MIN_PAUSE_MS { 0 } else { pause };
        let mut rest = atom.bytes.as_slice();
        while !rest.is_empty() {
            let take = (MAX_TEXT_CHUNK - pending.len()).min(rest.len());
            pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if pending.len() == MAX_TEXT_CHUNK {
                segments.push(PerformanceSegment {
                    bytes: std::mem::take(&mut pending),
                    pause_after_ms: 0,
                });
            }
        }
        if pause == 0 {
            continue;
        }
        if pending.is_empty() {
            if let Some(last) = segments.last_mut() {
                last.pause_after_ms = last.pause_after_ms.saturating_add(pause);
            }
        } else {
            segments.push(PerformanceSegment {
                bytes: std::mem::take(&mut pending),
                pause_after_ms: pause,
            });
        }
    }
    if !pending.is_empty() {
        segments.push(PerformanceSegment {
            bytes: pending,
            pause_after_ms: 0,
        });
    }
    Performance {
        lead_pause_ms: lead,
        segments,
    }
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

    const HUMAN_PAYLOADS: [(&str, TypingLanguage); 7] = [
        ("a\nb", TypingLanguage::Python),
        (
            "class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, num in enumerate(nums):\n            if target - num in seen:\n                return [seen[target - num], i]\n            seen[num] = i\n        return []\n",
            TypingLanguage::Python,
        ),
        (
            "#include <vector>\n\nclass Solution {\npublic:\n    bool can(int x) {\n        switch (x) {\n        case 1:\n            return true;\n        }\n        return false;\n    }\n};\n",
            TypingLanguage::Cpp,
        ),
        ("class A {\nif (k) {\nx\n}\ny\n}\nz\n", TypingLanguage::Cpp),
        ("z0\nif q:\nz1\nd = foo(\nz3\n)\nz4\n", TypingLanguage::Python),
        ("x = 1", TypingLanguage::Python),
        ("x", TypingLanguage::Python),
    ];

    fn human_spec(seed: u64) -> HumanSpec {
        HumanSpec {
            target_ms: 30 * 60_000,
            per_byte_ms: 26,
            seed,
        }
    }

    /// Plans a performance and flattens it the way the worker sends it.
    fn perform(source: &str, lang: TypingLanguage, spec: HumanSpec) -> (String, Vec<u8>, Performance) {
        let text = normalize_for_typing(source);
        let performance = plan_performance(&text, lang, spec).expect("performance");
        let joined: Vec<u8> = performance
            .segments
            .iter()
            .flat_map(|segment| segment.bytes.iter().copied())
            .collect();
        (text, joined, performance)
    }

    #[test]
    fn performance_reproduces_the_answer_for_every_seed() {
        for (source, lang) in HUMAN_PAYLOADS {
            for seed in 1..=25u64 {
                let (expected, joined, performance) = perform(source, lang, human_spec(seed));
                let mut sim = Sim::default();
                sim.run(&joined, lang);
                assert_eq!(sim.text(), expected, "seed {seed} source {source:?}");
                assert!(!performance.segments.is_empty(), "seed {seed}");
                for segment in &performance.segments {
                    assert!(!segment.bytes.is_empty(), "seed {seed}");
                    assert!(segment.bytes.len() <= MAX_TEXT_CHUNK, "seed {seed}");
                    assert!(
                        segment
                            .bytes
                            .iter()
                            .all(|b| matches!(b, 0x08 | 0x7f | b'\n') || (b' '..=b'~').contains(b)),
                        "seed {seed}"
                    );
                }
            }
        }
    }

    #[test]
    fn performance_fills_the_time_budget() {
        let (source, lang) = HUMAN_PAYLOADS[2];
        let text = normalize_for_typing(source);
        for (target_ms, seed) in [
            (30 * 60_000u64, 7u64),
            (10 * 60_000, 11),
            (2 * 60_000, 3),
            (60_000, 5),
        ] {
            let performance = plan_performance(
                &text,
                lang,
                HumanSpec {
                    target_ms,
                    per_byte_ms: 26,
                    seed,
                },
            )
            .expect("performance");
            let total = performance.total_ms(26);
            assert!(total <= target_ms, "seed {seed}: {total} > {target_ms}");
            assert!(
                total >= target_ms - target_ms / 20,
                "seed {seed}: {total} is under 95% of {target_ms}"
            );
        }
        let performance = plan_performance(&text, lang, human_spec(7)).expect("performance");
        assert!(performance.lead_pause_ms > 0);
        assert!(
            performance
                .segments
                .iter()
                .any(|segment| segment.pause_after_ms >= 30_000),
            "a half-hour session should contain long thinking pauses"
        );
    }

    #[test]
    fn performance_injects_mistakes_and_second_thoughts() {
        let (source, lang) = HUMAN_PAYLOADS[1];
        let text = normalize_for_typing(source);
        let plan = plan_typing(&text, lang).expect("plan");
        let plan_typos = plan.iter().filter(|b| **b == BS_OPCODE).count();
        let plan_deletes = plan.iter().filter(|b| **b == DEL_OPCODE).count();
        let mut seeds_with_mistakes = 0;
        for seed in 1..=40u64 {
            let (_, joined, _) = perform(source, lang, human_spec(seed));
            let typos = joined.iter().filter(|b| **b == BS_OPCODE).count();
            let deletes = joined.iter().filter(|b| **b == DEL_OPCODE).count();
            assert!(typos >= plan_typos, "seed {seed}");
            assert_eq!(deletes, plan_deletes, "seed {seed}");
            if typos > plan_typos {
                seeds_with_mistakes += 1;
            }
        }
        assert!(
            seeds_with_mistakes >= 30,
            "mistakes appeared in only {seeds_with_mistakes}/40 seeds"
        );
    }

    #[test]
    fn performances_are_deterministic_per_seed() {
        let (source, lang) = HUMAN_PAYLOADS[2];
        let text = normalize_for_typing(source);
        let first = plan_performance(&text, lang, human_spec(9)).expect("performance");
        let again = plan_performance(&text, lang, human_spec(9)).expect("performance");
        assert_eq!(first, again);
        let different = plan_performance(&text, lang, human_spec(10)).expect("performance");
        assert_ne!(first, different);
    }

    #[test]
    #[ignore = "prints one schedule for eyeballing"]
    fn debug_print_schedule() {
        let (source, lang) = HUMAN_PAYLOADS[1];
        let text = normalize_for_typing(source);
        let spec = human_spec(4);
        let performance = plan_performance(&text, lang, spec).expect("performance");
        println!(
            "lead={}s segments={} typed={}B total={}s budget={}s",
            performance.lead_pause_ms / 1000,
            performance.segments.len(),
            performance.typed_bytes(),
            performance.total_ms(spec.per_byte_ms) / 1000,
            spec.target_ms / 1000
        );
        for (index, segment) in performance.segments.iter().enumerate() {
            println!(
                "{index:>3} pause={:>6.1}s bytes={:?}",
                segment.pause_after_ms as f64 / 1000.0,
                String::from_utf8_lossy(&segment.bytes)
            );
        }
    }

    #[test]
    fn tiny_answers_borrow_the_time_from_the_lead_pause() {
        let text = normalize_for_typing("x");
        let spec = human_spec(3);
        let performance = plan_performance(&text, TypingLanguage::Python, spec).expect("performance");
        let total = performance.total_ms(26);
        assert!(total <= spec.target_ms);
        assert!(total >= spec.target_ms * 85 / 100, "{total}");
        assert_eq!(performance.segments.len(), 1);
        assert_eq!(performance.segments[0].bytes, b"x");
    }
}
