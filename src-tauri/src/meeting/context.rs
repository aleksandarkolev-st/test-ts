use super::TranscriptSegment;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const RECENT_MS: u64 = 300_000;
const RECENT_CHARS: usize = 24_000;
const MAX_PENDING_CHARS: usize = 32_000;
const MAX_ANSWER_HISTORY_CHARS: usize = 64_000;
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
    answers: VecDeque<(u64,String,String,String)>,
    visible_answer: Option<(String,String,String)>,
    // The working implementation outlives a short history of explanations.
    // Keep its exact text until a later complete code answer replaces it.
    working_code: Option<(u64,String,String,String)>,
}
impl MeetingContext {
    pub fn forget_visible_answer(&mut self,id:&str) {
        if self.visible_answer.as_ref().is_some_and(|(previous,_,_)|previous==id){self.visible_answer=None;}
    }
    /// A follow-up can refer to text already shown before generation completes.
    /// Preserve that exact snapshot without treating unfinished code as complete.
    pub fn remember_visible_answer(&mut self,id:&str,question:&str,answer:&str) {
        if answer.trim().is_empty() || answer.chars().count()>32_000{return;}
        if self.answers.iter().any(|(_,previous,_,_)|previous==id){return;}
        self.visible_answer=Some((id.into(),question.into(),answer.into()));
    }
    /// Preserve complete suggested answers, including code, independently of
    /// transcript compression. Suggestions are never promoted to meeting facts.
    #[cfg(test)]
    pub fn remember_answer(&mut self,id:&str,question:&str,answer:&str) {
        let order=self.answers.back().map_or(0,|(order,_,_,_)|order+1);
        self.remember_answer_at(id,question,answer,order);
    }
    pub fn remember_answer_at(&mut self,id:&str,question:&str,answer:&str,order:u64) {
        if answer.trim().is_empty() || answer.chars().count()>32_000{return;}
        self.forget_visible_answer(id);
        let fences=answer.matches("```").count();
        if fences>=2 && fences%2==0 && self.working_code.as_ref().is_none_or(|(previous,_,_,_)|order>=*previous) {self.working_code=Some((order,id.into(),question.into(),answer.into()));}
        self.answers.retain(|(_,previous,_,_)|previous!=id);
        self.answers.push_back((order,id.into(),question.into(),answer.into()));
        self.answers.make_contiguous().sort_by_key(|(order,_,_,_)|*order);
        while self.answers.len()>8 || self.answers.iter().map(|(_,_,q,a)|q.chars().count()+a.chars().count()).sum::<usize>()>MAX_ANSWER_HISTORY_CHARS {self.answers.pop_front();}
    }
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
        self.answer_context_for_utterance(question,None)
    }
    /// Short, plain conversation for intent classification only. This does not
    /// replace or truncate the exact context/code supplied to the answer model.
    pub fn classifier_context(&self,started:u64)->String {
        let mut parts=self.recent.iter().rev().filter(|segment|segment.started_at<started).take(4)
            .map(|segment|segment.text.chars().rev().take(300).collect::<String>().chars().rev().collect::<String>()).collect::<Vec<_>>();
        parts.reverse();
        let suggestion=self.visible_answer.as_ref().map(|(_,_,answer)|answer)
            .or_else(||self.answers.back().filter(|(at,_,_,_)|*at<started).map(|(_,_,_,answer)|answer));
        if let Some(answer)=suggestion {parts.push(answer.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>());}
        parts.join("\n").chars().rev().take(1200).collect::<String>().chars().rev().collect()
    }
    /// The current remote utterance is supplied as CURRENT QUESTION. Excluding
    /// its transcript fragments avoids treating their finalization as new facts.
    /// Other speakers, earlier turns, and exact suggested code remain available.
    pub fn answer_context_for_utterance(&self, question:&str,started:Option<u64>)->String {
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
            .filter(|segment|!started.is_some_and(|start|segment.source==super::SpeakerSource::Remote&&segment.started_at>=start))
            .cloned()
            .collect();
        let recent: Vec<_> = self.recent.iter().filter(|segment|!started.is_some_and(|start|segment.source==super::SpeakerSource::Remote&&segment.started_at>=start)).cloned().collect();
        let memory=select_lines(&memory,2_000,question);
        let pending=select_lines(&conversation(&pending).lines().map(String::from).collect::<Vec<_>>(),1_500,question);
        let recent=select_lines(&conversation(&recent).lines().map(String::from).collect::<Vec<_>>(),4_000,question);
        let mut selected=std::collections::BTreeSet::new();
        for index in self.answers.len().saturating_sub(2)..self.answers.len(){selected.insert(index);}
        let included_code=self.working_code.as_ref().is_some_and(|(_,code_id,_,_)|selected.iter().any(|i|self.answers[*i].1==*code_id));
        let mut answers=selected.into_iter().map(|i|{let (_,_,q,a)=&self.answers[i];format!("QUESTION: {q}\nSUGGESTED ANSWER:\n{a}")}).collect::<Vec<_>>().join("\n\n");
        if !included_code {if let Some((_,_,q,a))=&self.working_code{answers.push_str(&format!("\n\nLATEST COMPLETE SUGGESTED IMPLEMENTATION\nQUESTION: {q}\n{a}"));}}
        if let Some((_,q,a))=&self.visible_answer{answers.push_str(&format!("\n\nVISIBLE SUGGESTION STILL STREAMING OR INTERRUPTED (exact displayed text; may be unfinished or incorrect)\nQUESTION: {q}\n{a}"));}
        let history=if answers.is_empty(){String::new()}else{format!("\n\nPRIOR COPILOT SUGGESTIONS AND EXACT CODE (may contain mistakes; not accepted meeting facts; later spoken corrections take precedence)\n{answers}")};
        format!("MEETING SUMMARY (selected relevant memory)\n{memory}\n\nEARLIER CONVERSATION AWAITING COMPRESSION (selected excerpts)\n{pending}\n\nRECENT CONVERSATION (selected excerpts)\n{recent}{history}")
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
    #[test]
    fn current_utterance_fragments_do_not_change_selected_context_but_other_speakers_do() {
        let mut c=MeetingContext::default();c.push(seg(1,"Earlier launch date: February 19."));
        c.remember_answer("code","Implement","```rust\nlet exact=17;\n```");
        let before=c.answer_context_for_utterance("What is the launch date?",Some(10));
        let mut first=seg(11,"What is the");first.started_at=10;c.push(first);
        let mut second=seg(12,"launch date?");second.started_at=10;c.push(second);
        assert_eq!(before,c.answer_context_for_utterance("What is the launch date?",Some(10)));
        let mut correction=seg(13,"The launch date changed to March 22.");correction.source=SpeakerSource::Self_;c.push(correction);
        let refreshed=c.answer_context_for_utterance("What is the launch date?",Some(10));
        assert_ne!(before,refreshed);assert!(refreshed.contains("March 22"));assert!(refreshed.contains("let exact=17;"));
        assert!(c.answer_context("What is the launch date?").contains("REMOTE: launch date?"));
    }
    #[test]
    fn late_completion_of_an_older_turn_does_not_replace_the_newer_implementation() {
        let mut c=MeetingContext::default();
        c.remember_answer_at("new","Revise","```rust\nlet newest=2;\n```",20);
        c.remember_answer_at("old","Implement","```rust\nlet oldest=1;\n```",10);
        c.remember_answer_at("followup","Explain","The latest invariant.",30);
        let prompt=c.prompt("Which code are we using?");
        assert!(prompt.contains("let newest=2"));assert!(!prompt.contains("let oldest=1"));
        for order in 31..50{c.remember_answer_at(&order.to_string(),"Why","An explanation.",order);}
        let prompt=c.prompt("Prove it");
        assert!(prompt.contains("let newest=2"));assert!(!prompt.contains("let oldest=1"));
    }
    #[test]
    fn followup_retains_visible_unfinished_code_without_replacing_complete_code() {
        let mut c=MeetingContext::default();
        c.remember_answer("complete","Implement","```rust\nlet complete=1;\n```");
        let visible="Revise it this way.\n```rust\nlet unfinished=2;";
        c.remember_visible_answer("stream","Revise",visible);
        let prompt=c.prompt("Why did you change that line?");
        assert!(prompt.contains(visible));assert!(prompt.contains("may be unfinished"));
        assert!(prompt.contains("let complete=1"));
        let completed="```rust\nlet unfinished=2;\n```";
        c.remember_answer("stream","Revise",completed);
        assert!(!c.prompt("Why?").contains("STILL STREAMING"));
        assert_eq!(c.prompt("Why?").matches("let unfinished=2").count(),1);
        c.remember_visible_answer("stream","Revise",completed);
        assert!(!c.prompt("Why?").contains("STILL STREAMING"));
        c.clear();assert!(!c.prompt("Why?").contains("unfinished=2"));
    }
    #[test]
    fn exact_code_survives_compression_and_short_followups() {
        let mut c=MeetingContext::default();
        let code=format!("Use this kernel.\n```cuda\n{}\nunsigned mask = 0x1ffff;\n```","// preserve this line\n".repeat(400));
        c.remember_answer("code","Implement the reduction",&code);
        for i in 0..40{c.remember_answer(&format!("q{i}"),"Why?",&format!("Explanation {i}"));}
        c.push(seg(1,"Actually use 7 threads and 3 valid elements."));
        c.complete_summary(Memory::default());
        let prompt=c.prompt("Is that mask valid?");
        assert!(prompt.contains(&code));assert!(prompt.contains("Explanation 39"));
        assert!(prompt.contains("7 threads"));assert!(prompt.contains("may contain mistakes"));
        c.clear();assert!(!c.prompt("Why?").contains("0x1ffff"));
    }
    #[test]
    fn latest_complete_code_replaces_prior_code_and_is_not_duplicated() {
        let mut c=MeetingContext::default();
        c.remember_answer("first","Implement","```rust\nlet old=1;\n```");
        c.remember_answer("new","Revise","```rust\nlet revised=2;\n```");
        assert_eq!(c.prompt("Prove it").matches("let revised=2").count(),1);
        c.remember_answer("partial","Revise","```rust\nlet truncated");
        for i in 0..12{c.remember_answer(&format!("later{i}"),"Why","An explanation.");}
        assert!(!c.prompt("Prove it").contains("let old=1"));
        assert!(c.prompt("Prove it").contains("let revised=2"));
    }
    #[test]
    fn answer_history_is_bounded_without_cutting_code() {
        let mut c=MeetingContext::default();
        for i in 0..10 {c.remember_answer(&i.to_string(),"Explain",&format!("```cuda\n{}\n```","x".repeat(30_000)));}
        assert_eq!(c.answers.len(),2);
        assert!(c.answers.iter().all(|(_,_,_,a)|a.ends_with("```")));
    }
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
