use super::{SpeakerSource, TranscriptSegment};
pub const END_WAIT_MS: u64 = 500;

pub fn score(text: &str, self_speaking: bool) -> i32 {
    let t = text.trim().to_lowercase();
    let mut n = 0;
    if t.ends_with('?') {
        n += 4;
    }
    if ["why", "what", "how", "who", "when", "where"]
        .iter()
        .any(|w| t == *w || t.starts_with(&format!("{w} ")))
    {
        n += 3;
    }
    for p in ["can you", "could you", "do you"] {
        if t.contains(p) {
            n += 3;
        }
    }
    for p in ["what do you think", "any idea"] {
        if t.contains(p) {
            n += 2;
        }
    }
    if [
        "who cares",
        "who knows",
        "you know what i mean",
        "isn't it obvious",
        "right?",
        "don't you agree",
    ]
    .iter()
    .any(|p| t.contains(p))
    {
        n -= 3;
        // Explicit rhetorical patterns are a veto even when both question
        // punctuation and an interrogative opening contribute to the score.
        n = n.min(3);
    }
    if self_speaking {
        n -= 5;
    }
    n
}
#[derive(Default)]
pub struct QuestionDetector {
    pub remote_speaking: bool,
    pub self_speaking: bool,
    pub stopped_at: Option<u64>,
    text: String,
    pub continued: bool,
    pub last_question: String,
    awaiting_final: bool,
}
impl QuestionDetector {
    pub fn speech_started(&mut self, source: SpeakerSource, now: u64) {
        match source {
            SpeakerSource::Remote => {
                if !self.continued
                    && self
                        .stopped_at
                        .is_some_and(|t| now.saturating_sub(t) > 1500)
                {
                    self.text.clear();
                }
                self.remote_speaking = true;
                self.stopped_at = None;
            }
            SpeakerSource::Self_ => self.self_speaking = true,
        }
    }
    pub fn speech_ended(&mut self, source: SpeakerSource, now: u64) {
        match source {
            SpeakerSource::Remote => {
                self.remote_speaking = false;
                self.stopped_at = Some(now);
                self.awaiting_final = true;
            }
            SpeakerSource::Self_ => self.self_speaking = false,
        }
    }
    pub fn transcript(&mut self, segment: &TranscriptSegment) -> bool {
        if segment.source != SpeakerSource::Remote || !segment.final_ {
            return false;
        }
        if self.stopped_at.is_some_and(|t| segment.ended_at >= t) {
            self.awaiting_final = false;
        }
        let text = segment.text.trim();
        if !text.is_empty() {
            if !self.text.is_empty() {
                self.text.push(' ');
            }
            self.text.push_str(text);
        }
        // A follow-up need not itself contain a question mark.
        self.continued || score(&self.text, false) >= 4
    }
    pub fn confirm(&mut self, now: u64) -> Option<(String, u64)> {
        if self.remote_speaking
            || self.self_speaking
            || self.awaiting_final
            || !self
                .stopped_at
                .is_some_and(|t| now.saturating_sub(t) >= END_WAIT_MS)
        {
            return None;
        }
        if self.text.is_empty() || (!self.continued && score(&self.text, false) < 4) {
            return None;
        }
        let text = std::mem::take(&mut self.text);
        self.last_question = text.clone();
        self.continued = false;
        Some((text, self.stopped_at.unwrap()))
    }
    pub fn continue_question(&mut self) {
        self.text = self.last_question.clone();
        self.continued = !self.text.is_empty();
    }
    pub fn may_continue(&self, now: u64) -> bool {
        !self.last_question.is_empty()
            && self
                .stopped_at
                .is_some_and(|t| now.saturating_sub(t) <= 3000)
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(t: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: "q".into(),
            source: SpeakerSource::Remote,
            text: t.into(),
            started_at: 0,
            ended_at: 100,
            final_: true,
        }
    }
    #[test]
    fn scoring_and_rhetorical_filter() {
        assert!(score("What is our launch target?", false) >= 4);
        assert!(score("Who cares?", false) < 4);
        assert!(score("We launch next week", false) < 4);
        assert_eq!(score("Can you clarify?", true), 2);
    }
    #[test]
    fn continued_question_and_self_suppression() {
        let mut q = QuestionDetector::default();
        q.speech_started(SpeakerSource::Remote, 0);
        q.speech_ended(SpeakerSource::Remote, 100);
        q.transcript(&s("What is our launch target?"));
        assert!(q.confirm(599).is_none());
        assert!(q.confirm(600).is_some());
        q.continue_question();
        q.speech_started(SpeakerSource::Remote, 700);
        q.speech_ended(SpeakerSource::Remote, 900);
        let mut follow = s("Assuming Microsoft approves next week");
        follow.ended_at = 900;
        q.transcript(&follow);
        q.speech_started(SpeakerSource::Self_, 1000);
        assert!(q.confirm(1400).is_none());
        q.speech_ended(SpeakerSource::Self_, 1500);
        assert_eq!(
            q.confirm(1500).unwrap().0,
            "What is our launch target? Assuming Microsoft approves next week"
        );
    }
    #[test]
    fn empty_final_after_chunk_boundary_releases_end_confirmation() {
        let mut q = QuestionDetector::default();
        q.speech_started(SpeakerSource::Remote, 0);
        q.transcript(&s("What is our launch target?"));
        assert!(q.confirm(600).is_none());
        q.speech_ended(SpeakerSource::Remote, 100);
        assert!(q.confirm(600).is_none());
        q.transcript(&s(""));
        assert_eq!(q.confirm(600).unwrap().0, "What is our launch target?");
        let mut empty = QuestionDetector::default();
        empty.speech_started(SpeakerSource::Remote, 0);
        empty.speech_ended(SpeakerSource::Remote, 100);
        empty.transcript(&s(""));
        assert!(empty.confirm(600).is_none());
    }
}
