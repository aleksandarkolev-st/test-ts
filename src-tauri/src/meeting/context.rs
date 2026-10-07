use super::TranscriptSegment;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const RECENT_MS: u64 = 300_000;
const RECENT_CHARS: usize = 24_000;
const MAX_PENDING_CHARS: usize = 32_000;
pub const ANSWER_CONTEXT_CHARS: usize = 8_000;

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
        format!("{}\n\nCURRENT QUESTION\n{question}",self.answer_context(question))
    }
    pub fn answer_context(&self, question:&str)->String {
        // Keep the archive and summary retry behavior intact; retrieval bounds
        // apply only to the latency-sensitive answer prompt.
        let mut memory=vec![format!("Summary: {}",self.memory.summary)];
        for (label,items) in [("Fact",&self.memory.facts),("Decision",&self.memory.decisions),("Date",&self.memory.dates),("Person",&self.memory.people),("Open question",&self.memory.open_questions)] {
            memory.extend(items.iter().map(|item|format!("{label}: {item}")));
        }
        let pending: Vec<_> = self
            .in_flight
            .iter()
            .chain(self.older.iter())
            .cloned()
            .collect();
        let recent: Vec<_> = self.recent.iter().cloned().collect();
        let memory=select_lines(&memory,2_000,question);
        let pending=select_lines(&conversation(&pending).lines().map(String::from).collect::<Vec<_>>(),1_500,question);
        let recent=select_lines(&conversation(&recent).lines().map(String::from).collect::<Vec<_>>(),4_000,question);
        format!("MEETING SUMMARY (selected relevant memory)\n{memory}\n\nEARLIER CONVERSATION AWAITING COMPRESSION (selected excerpts)\n{pending}\n\nRECENT CONVERSATION (selected excerpts)\n{recent}")
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}
fn select_lines(lines:&[String],budget:usize,question:&str)->String {
    let query=super::scheduler::normalized(question).split_whitespace()
        .filter(|word|word.len()>2 && !["what","when","where","which","how","who","why","the","our","are","was","does","did","can","you","and","for","with","this","that"].contains(word))
        .map(String::from).collect::<std::collections::HashSet<_>>();
    let mut ranked=lines.iter().enumerate().map(|(i,line)|{
        let words=super::scheduler::normalized(line);
        let score=words.split_whitespace().filter(|word|query.contains(*word)).count();
        (score,i,line)
    }).collect::<Vec<_>>();
    ranked.sort_by(|a,b|b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut selected=Vec::new();let mut remaining=budget;
    for (_,i,line) in ranked {
        let len=line.chars().count()+1;
        if len<=remaining {selected.push((i,line.clone()));remaining-=len;}
        else if selected.is_empty() && remaining>1 {selected.push((i,line.chars().take(remaining-1).collect::<String>()));break;}
    }
    selected.sort_by_key(|(i,_)|*i);
    selected.into_iter().map(|(_,line)|line).collect::<Vec<_>>().join("\n")
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
    fn answer_prompt_is_bounded_and_recalls_relevant_old_facts() {
        let mut c=MeetingContext::default();
        c.push(seg(1,"The launch target is February 19."));
        for i in 2..300 {c.push(seg(i*1000,&format!("Unrelated discussion {i}: {}","budget review ".repeat(20))));}
        c.memory.summary="Other decisions. ".repeat(250);
        c.memory.dates=vec!["Launch target February 19".into()];
        let prompt=c.prompt("What is our launch target?");
        assert!(prompt.chars().count()<ANSWER_CONTEXT_CHARS+30);
        assert!(prompt.contains("February 19"));
        assert!(prompt.ends_with("What is our launch target?"));
        assert!(c.chars<=RECENT_CHARS);
    }
    #[test]
    fn completing_a_topic_refreshes_the_relevant_excerpts() {
        let mut c=MeetingContext::default();
        c.memory.facts.push("Launch date is February 19".into());
        for i in 0..200 {c.memory.facts.push(format!("Unrelated budget review {i}: {}","other decisions ".repeat(8)));}
        let provisional=c.answer_context("What is our la");
        let completed=c.answer_context("What is our launch date");
        assert!(!provisional.contains("February 19"));
        assert!(completed.contains("February 19"));
        assert!(completed.chars().count()<ANSWER_CONTEXT_CHARS);
    }
    #[test]
    fn retrieval_handles_unicode_and_keeps_speaker_labels() {
        let mut c=MeetingContext::default();c.push(seg(1,&"Launch: Київ 🚀 ".repeat(1000)));
        let prompt=c.prompt("Where is the launch?");
        assert!(prompt.contains("REMOTE: Launch:"));assert!(prompt.chars().count()<ANSWER_CONTEXT_CHARS+30);
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
