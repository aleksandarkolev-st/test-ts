use super::TranscriptSegment;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const RECENT_MS: u64 = 300_000;
const RECENT_CHARS: usize = 24_000;
const MAX_PENDING_CHARS: usize = 32_000;

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct Memory {
    pub summary: String,
    pub facts: Vec<String>,
    pub decisions: Vec<String>,
    pub dates: Vec<String>,
    pub people: Vec<String>,
    pub open_questions: Vec<String>,
}
impl Memory {
    pub fn bounded(mut self) -> Self {
        self.summary = self.summary.chars().take(4000).collect();
        for items in [
            &mut self.facts,
            &mut self.decisions,
            &mut self.dates,
            &mut self.people,
            &mut self.open_questions,
        ] {
            items.truncate(30);
            for item in items.iter_mut() {
                *item = item.chars().take(300).collect();
            }
        }
        self
    }
}

#[derive(Default)]
pub struct MeetingContext {
    pub recent: VecDeque<TranscriptSegment>,
    pub memory: Memory,
    older: VecDeque<TranscriptSegment>,
    in_flight: Vec<TranscriptSegment>,
    chars: usize,
}
impl MeetingContext {
    pub fn push(&mut self, segment: TranscriptSegment) {
        if !segment.final_ || segment.text.trim().is_empty() {
            return;
        }
        let now = segment.ended_at;
        self.chars += segment.text.len();
        self.recent.push_back(segment);
        while self
            .recent
            .front()
            .is_some_and(|s| now.saturating_sub(s.ended_at) > RECENT_MS)
            || self.chars > RECENT_CHARS
        {
            if let Some(old) = self.recent.pop_front() {
                self.chars -= old.text.len();
                self.older.push_back(old);
            } else {
                break;
            }
        }
        // A failed summarizer cannot create an unbounded transcript archive.
        while self.older.iter().map(|s| s.text.len()).sum::<usize>() > MAX_PENDING_CHARS {
            self.older.pop_front();
        }
    }
    pub fn take_summary_batch(&mut self) -> Option<Vec<TranscriptSegment>> {
        if self.older.is_empty() || !self.in_flight.is_empty() {
            None
        } else {
            self.in_flight = self.older.drain(..).collect();
            Some(self.in_flight.clone())
        }
    }
    pub fn complete_summary(&mut self, memory: Memory) {
        self.memory = memory.bounded();
        self.in_flight.clear();
    }
    pub fn fail_summary(&mut self) {
        for s in self.in_flight.drain(..).rev() {
            self.older.push_front(s);
        }
        while self.older.iter().map(|s| s.text.len()).sum::<usize>() > MAX_PENDING_CHARS {
            self.older.pop_front();
        }
    }
    pub fn prompt(&self, question: &str) -> String {
        let memory = serde_json::to_string(&self.memory).unwrap_or_default();
        let pending: Vec<_> = self
            .in_flight
            .iter()
            .chain(self.older.iter())
            .cloned()
            .collect();
        let recent: Vec<_> = self.recent.iter().cloned().collect();
        format!("MEETING SUMMARY\n{memory}\n\nEARLIER CONVERSATION AWAITING COMPRESSION\n{}\n\nRECENT CONVERSATION\n{}\n\nCURRENT QUESTION\n{question}", conversation(&pending), conversation(&recent))
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}
pub fn conversation(segments: &[TranscriptSegment]) -> String {
    segments
        .iter()
        .map(|s| {
            format!(
                "{}: {}",
                if s.source == super::SpeakerSource::Remote {
                    "REMOTE"
                } else {
                    "SELF"
                },
                s.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::SpeakerSource;
    fn seg(i: u64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: i.to_string(),
            source: SpeakerSource::Remote,
            text: text.into(),
            started_at: i,
            ended_at: i,
            final_: true,
        }
    }
    #[test]
    fn rolls_and_preserves_old_context_until_compressed() {
        let mut c = MeetingContext::default();
        c.push(seg(1, "Launch October 28"));
        c.push(seg(300_002, "Why?"));
        assert_eq!(c.recent.len(), 1);
        assert!(c.prompt("Why?").contains("Launch October 28"));
        assert_eq!(c.take_summary_batch().unwrap().len(), 1);
        c.clear();
        assert!(c.recent.is_empty());
        assert!(c.memory.summary.is_empty());
    }
    #[test]
    fn bounded_for_hour_long_meetings() {
        let mut c = MeetingContext::default();
        for i in 0..36000 {
            c.push(seg(i * 100, "Some meeting text repeated repeatedly."));
        }
        assert!(c.chars <= RECENT_CHARS);
        assert!(c.older.iter().map(|s| s.text.len()).sum::<usize>() <= MAX_PENDING_CHARS);
    }
    #[test]
    fn summarization_preserves_context_in_flight_and_retries_without_duplicates() {
        let mut c = MeetingContext::default();
        c.push(seg(1, "The launch date is October 28"));
        c.push(seg(300_002, "New discussion"));
        assert!(c.take_summary_batch().is_some());
        assert!(c.take_summary_batch().is_none());
        assert!(c.prompt("When?").contains("October 28"));
        c.fail_summary();
        assert_eq!(c.take_summary_batch().unwrap().len(), 1);
        c.complete_summary(Memory {
            dates: vec!["October 28".into()],
            ..Default::default()
        });
        assert!(c.prompt("When?").contains("October 28"));
        assert!(c.in_flight.is_empty());
        assert!(c.older.is_empty());
        c.clear();
        assert!(!c.prompt("When?").contains("October 28"));
    }
}
