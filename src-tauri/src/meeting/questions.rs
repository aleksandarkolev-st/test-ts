use super::{SpeakerSource, TranscriptSegment};
pub const END_WAIT_MS: u64 = 200;
const REMOTE_CLAUSE_GAP_MS:u64=1500;

pub fn score(text: &str, self_speaking: bool) -> i32 {
    let t = text.trim().to_lowercase();
    let mut n = 0;
    if t.ends_with('?') {
        n += 4;
    }
    if ["why", "what", "how", "who", "when", "where", "which"]
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
    // Nemotron RNNT emits plain words unless a separate punctuation model is
    // configured. Direct interrogative grammar must still qualify without '?'.
    // Keep declarative openings such as "What we need is..." below threshold.
    if !t.ends_with('?') && [
        "what is ","what are ","what was ","what will ","what would ","what should ","what do ","what does ","what did ","what's ",
        "how is ","how are ","how do ","how does ","how did ","how can ","how could ","how would ","how should ",
        "when is ","when are ","when will ","where is ","where are ","who is ","who will ","why is ","why are ","why do ","why did ",
        "can you ","could you ","do you ",
    ].iter().any(|p|t.starts_with(p)) {n+=1;}
    if !t.ends_with('?') {
        // RNNT punctuation is optional. Also cover noun/quantity questions
        // and yes/no inversion, while keeping common declarative fragments
        // ("what we need", "how it works") below the threshold.
        let words: Vec<_> = t.split_whitespace().collect();
        let wh = words.first().is_some_and(|w| ["why","what","how","who","when","where","which"].contains(w));
        let declarative = words.get(1).is_some_and(|w| ["we","i","you","they","he","she","it","to","i'm","we're","it's"].contains(w));
        if wh && !declarative && n == 3 { n += 1; }
        let copula = words.first().is_some_and(|w| ["is","are","was","were"].contains(w))
            && words.len() >= 3 && words.get(1) != Some(&"not");
        let inversion = words.first().is_some_and(|w| ["can","could","will","would","should","do","does","did","has","have"].contains(w))
            && words.get(1).is_some_and(|w| ["we","i","you","they","he","she","it","this","that"].contains(w))
            && words.len() >= 3;
        if (copula || inversion) && n < 4 { n = 4; }
        if ["any idea why ","any idea how ","any idea what ","any idea when ","any idea where "].iter().any(|p|t.starts_with(p)) { n += 2; }
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
    /// Signed-in streaming inference decides reply intent in the same turn.
    /// Local grammar remains a fallback for transports without intent framing.
    pub semantic_intent: bool,
    pub remote_speaking: bool,
    pub remote_quiet: bool,
    pub self_speaking: bool,
    pub stopped_at: Option<u64>,
    pub remote_turn_started_at: Option<u64>,
    remote_turn_interrupted: bool,
    text: String,
    pub continued: bool,
    pub last_question: String,
    last_question_turn_started_at: Option<u64>,
    awaiting_final: bool,
    final_through: Option<u64>,
    partial: String,
}
impl QuestionDetector {
    pub fn speech_started(&mut self, source: SpeakerSource, now: u64) -> bool {
        let mut resumed=false;
        match source {
            SpeakerSource::Remote => {
                self.remote_quiet=false;
                resumed=self.semantic_intent&&!self.remote_turn_interrupted
                    &&self.remote_turn_started_at.is_some()
                    &&self.stopped_at.is_some_and(|t|now.saturating_sub(t)<=REMOTE_CLAUSE_GAP_MS);
                if resumed {
                    // A VAD pause is not a semantic turn boundary. Final ASR
                    // segments may arrive on either side of the next Started.
                    if self.text.is_empty(){self.text=self.last_question.clone();}
                    self.continued=true;
                } else if self.semantic_intent || (!self.continued
                    && self
                        .stopped_at
                        .is_some_and(|t| self.semantic_intent || now.saturating_sub(t) > 1500 || score(&self.text,false)<4)
                ) {
                    self.text.clear();
                    self.continued=false;
                }
                if !resumed {self.remote_turn_started_at=Some(now);}
                self.remote_turn_interrupted=false;
                self.remote_speaking = true;
                self.partial.clear();
                self.stopped_at = None;
                self.final_through = None;
            }
            SpeakerSource::Self_ => {self.self_speaking = true;self.remote_turn_interrupted=true;},
        }
        resumed
    }
    pub fn speech_ended(&mut self, source: SpeakerSource, now: u64) {
        match source {
            SpeakerSource::Remote => {
                self.remote_speaking = false;
                self.remote_quiet = true;
                self.stopped_at = Some(now);
                // Streaming recognizers may finalize before our independent
                // VAD delivers Ended. A final covering this audio endpoint
                // already satisfies the finalization fence.
                self.awaiting_final = !self.final_through.is_some_and(|t| t >= now);
            }
            SpeakerSource::Self_ => self.self_speaking = false,
        }
    }
    pub fn transcript(&mut self, segment: &TranscriptSegment) -> bool {
        if segment.source != SpeakerSource::Remote {
            return false;
        }
        // ASR can finalize the next words before VAD delivers their Started.
        // Confirmation moved the earlier clauses out of text; restore only
        // those confirmed on this same uninterrupted, recent acoustic floor.
        if self.semantic_intent && self.text.is_empty() && !segment.text.trim().is_empty()
            && !self.remote_turn_interrupted && self.remote_turn_started_at.is_some_and(|start|segment.started_at>=start)
            && self.last_question_turn_started_at==self.remote_turn_started_at
            && self.stopped_at.is_some_and(|stop|segment.started_at.saturating_sub(stop)<=REMOTE_CLAUSE_GAP_MS
                &&segment.ended_at.saturating_sub(stop)<=REMOTE_CLAUSE_GAP_MS) {
            self.text=self.last_question.clone();self.continued=true;
        }
        if !segment.final_ { self.partial=segment.text.trim().into(); return self.candidate().is_some(); }
        self.partial.clear();
        self.final_through = Some(self.final_through.unwrap_or(0).max(segment.ended_at));
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
        self.candidate().is_some()
    }
    pub fn speech_activity(&mut self,source:SpeakerSource,timestamp:u64,quiet:bool) {
        if source==SpeakerSource::Remote && self.remote_speaking
            && self.remote_turn_started_at.is_some_and(|start|timestamp>=start) {
            self.remote_quiet=quiet;
        }
    }
    pub fn candidate(&self) -> Option<String> {
        let text=format!("{} {}",self.text,self.partial).trim().to_string();
        if self.semantic_intent {
            // No topic or phrase allowlist. Delay incomplete one-word partials
            // without suppressing a final short follow-up such as "why".
            return (!self.self_speaking && !text.is_empty()
                && (self.partial.is_empty() || text.split_whitespace().count()>=3))
                .then_some(text);
        }
        // An interrogative opening has no answerable topic yet. Starting on
        // "What is our" spends a turn before any useful intent is available.
        let informative=super::scheduler::normalized(&text).split_whitespace().any(|word|
            !["what","why","how","when","where","who","which","is","are","was","were","will","would","should","could","can","do","does","did","have","has","had","we","our","us","you","your","the","a","an","it","this","that","there","think","tell","me","about","please","and","also","actually"].contains(&word));
        if !self.self_speaking && informative && (self.continued || score(&text,false)>=4 || (!self.last_question.is_empty() && super::scheduler::related(&text))) {Some(text)} else {None}
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
        if self.text.is_empty() || (!self.semantic_intent && !self.continued && score(&self.text, false) < 4 && !( !self.last_question.is_empty() && super::scheduler::related(&self.text))) {
            return None;
        }
        let text = std::mem::take(&mut self.text);
        self.partial.clear();
        self.last_question = text.clone();
        self.last_question_turn_started_at=self.remote_turn_started_at;
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
        let semantic_intent=self.semantic_intent;
        *self = Self {semantic_intent,..Self::default()};
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recorded_asr_final_before_vad_start_keeps_the_confirmed_prefix() {
        let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/asr-before-vad-start.json")).unwrap();
        let mut q=QuestionDetector{semantic_intent:true,..Default::default()};
        let mut confirmations=0;
        for e in fixture["events"].as_array().unwrap(){let p=&e["payload"];
            match e["name"].as_str().unwrap(){
                "speech.started"=>{q.speech_started(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap());},
                "speech.ended"=>q.speech_ended(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap()),
                "transcript"=>{q.transcript(&serde_json::from_value(p.clone()).unwrap());},
                "question.confirmed"=>{q.confirm(p["timestamp"].as_u64().unwrap()).unwrap();confirmations+=1;},_=>{}
            }
        }
        assert_eq!(confirmations,3);
        assert_eq!(q.last_question,fixture["expected"].as_str().unwrap());
        assert_eq!(q.remote_turn_started_at,fixture["turnStartedAt"].as_u64());
    }
    #[test]
    fn late_asr_prefix_restoration_requires_the_same_recent_uninterrupted_floor() {
        for mode in ["old","gap","late_end","self"] {
            let mut q=QuestionDetector{semantic_intent:true,..Default::default()};
            q.speech_started(SpeakerSource::Remote,100);
            let mut initial=s("Evaluate the original constraints");initial.started_at=100;initial.ended_at=200;
            q.transcript(&initial);q.speech_ended(SpeakerSource::Remote,200);q.confirm(400).unwrap();
            let mut tail=s("Analyze the new request");tail.started_at=match mode{"old"=>99,"gap"=>1800,_=>450};
            tail.ended_at=if mode=="gap"||mode=="late_end"{1801}else{tail.started_at+100};
            if mode=="self"{q.speech_started(SpeakerSource::Self_,410);q.speech_ended(SpeakerSource::Self_,440);}
            q.transcript(&tail);assert_eq!(q.candidate().unwrap(),tail.text,"{mode}");
        }
    }
    #[test]
    fn acoustic_pause_does_not_confirm_or_break_a_remote_turn() {
        let mut q=QuestionDetector{semantic_intent:true,..Default::default()};
        q.speech_started(SpeakerSource::Remote,100);
        let mut partial=s("Explain both configurations");partial.final_=false;q.transcript(&partial);
        q.speech_activity(SpeakerSource::Remote,500,true);
        assert!(q.remote_quiet&&q.remote_speaking);assert!(q.confirm(900).is_none());
        q.speech_activity(SpeakerSource::Self_,600,false);assert!(q.remote_quiet);
        q.speech_activity(SpeakerSource::Remote,99,false);assert!(q.remote_quiet);
        q.speech_activity(SpeakerSource::Remote,950,false);assert!(!q.remote_quiet);
        partial.text="Explain both configurations and the failure condition".into();q.transcript(&partial);
        assert_eq!(q.candidate().unwrap(),partial.text);
        q.speech_ended(SpeakerSource::Remote,1100);assert!(q.confirm(1500).is_none());
        let mut final_=partial;final_.final_=true;final_.ended_at=1100;q.transcript(&final_);
        assert_eq!(q.confirm(1500).unwrap().0,final_.text);
    }
    #[test]
    fn recorded_multipart_audio_keeps_all_clauses_across_vad_pauses() {
        let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/multipart-remote-turn.json")).unwrap();
        let mut q=QuestionDetector{semantic_intent:true,..Default::default()};
        for event in fixture["events"].as_array().unwrap() {
            let p=&event["payload"];
            match event["name"].as_str().unwrap() {
                "speech.started"=>{q.speech_started(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap());},
                "speech.ended"=>q.speech_ended(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap()),
                "transcript"=>{q.transcript(&serde_json::from_value(p.clone()).unwrap());},
                "question.confirmed"=>{q.confirm(p["timestamp"].as_u64().unwrap());},_=>{}
            }
        }
        assert_eq!(q.last_question,fixture["expected"].as_str().unwrap());
        assert_eq!(q.remote_turn_started_at,Some(76995));
    }
    #[test]
    fn remote_clauses_resume_but_self_speech_and_long_gaps_start_new_turns() {
        let mut q=QuestionDetector{semantic_intent:true,..Default::default()};
        q.speech_started(SpeakerSource::Remote,0);q.transcript(&s("Evaluate both resource configurations"));
        q.speech_ended(SpeakerSource::Remote,100);q.confirm(300).unwrap();
        assert!(q.speech_started(SpeakerSource::Remote,760));
        let mut tail=s("and explain the safety condition");tail.started_at=760;tail.ended_at=900;
        q.transcript(&tail);q.speech_ended(SpeakerSource::Remote,900);
        assert_eq!(q.confirm(1100).unwrap().0,"Evaluate both resource configurations and explain the safety condition");
        q.speech_started(SpeakerSource::Self_,1200);q.speech_ended(SpeakerSource::Self_,1250);
        assert!(!q.speech_started(SpeakerSource::Remote,1300));assert!(q.candidate().is_none());
        let mut next=s("Now derive a counterexample");next.ended_at=1400;q.transcript(&next);q.speech_ended(SpeakerSource::Remote,1400);
        assert_eq!(q.confirm(1600).unwrap().0,next.text);
        assert!(!q.speech_started(SpeakerSource::Remote,4000));assert!(q.candidate().is_none());
        assert_eq!(q.remote_turn_started_at,Some(4000));
    }
    #[test]
    fn semantic_mode_does_not_need_a_phrase_or_topic_allowlist() {
        for text in ["A GPU suddenly becomes x", "Derive the invariant", "Now this fails", "why", "How so", "The incident is resolved"] {
            let mut q=QuestionDetector{semantic_intent:true,..Default::default()};
            q.speech_started(SpeakerSource::Remote,0);q.transcript(&s(text));q.speech_ended(SpeakerSource::Remote,100);
            assert_eq!(q.confirm(300).unwrap().0,text);
            q.clear();assert!(q.semantic_intent);
            q.speech_started(SpeakerSource::Self_,400);assert!(q.candidate().is_none());
        }
    }
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
    fn incomplete_openings_wait_for_a_topic_but_final_vague_questions_still_confirm() {
        let mut q=QuestionDetector::default();q.speech_started(SpeakerSource::Remote,0);
        let mut partial=s("What is our");partial.final_=false;
        assert!(!q.transcript(&partial));partial.text="What is our revenue".into();assert!(q.transcript(&partial));
        q.speech_ended(SpeakerSource::Remote,100);q.transcript(&s("What is our?"));
        assert!(q.confirm(300).is_some());
    }
    #[test]
    fn recent_statement_does_not_hide_the_next_partial_question() {
        let mut q=QuestionDetector::default();q.speech_started(SpeakerSource::Remote,0);
        q.speech_ended(SpeakerSource::Remote,100);q.transcript(&s("The launch target is February 19"));
        q.speech_started(SpeakerSource::Remote,1000);
        let mut partial=s("What is our launch target");partial.final_=false;
        assert!(q.transcript(&partial));assert_eq!(q.candidate().unwrap(),"What is our launch target");
        q.speech_ended(SpeakerSource::Remote,1100);
        let mut final_=s("What is our launch target for next quarter");final_.ended_at=1100;
        q.transcript(&final_);assert_eq!(q.confirm(1300).unwrap().0,final_.text);
    }
    #[test]
    fn partial_candidates_never_bypass_final_confirmation_and_false_final_retracts() {
        let mut q=QuestionDetector::default();q.speech_started(SpeakerSource::Remote,0);
        let mut partial=s("What is our target");partial.final_=false;
        assert!(q.transcript(&partial));assert_eq!(q.candidate().unwrap(),"What is our target");
        q.speech_ended(SpeakerSource::Remote,100);assert!(q.confirm(300).is_none());
        assert!(!q.transcript(&s("What we need is another review")));assert!(q.candidate().is_none());assert!(q.confirm(300).is_none());
    }
    #[test]
    fn changed_final_replaces_partial_and_self_speech_blocks_speculation() {
        let mut q=QuestionDetector::default();q.speech_started(SpeakerSource::Remote,0);
        let mut partial=s("What is our target");partial.final_=false;q.transcript(&partial);
        q.speech_started(SpeakerSource::Self_,50);assert!(q.candidate().is_none());q.speech_ended(SpeakerSource::Self_,80);
        q.speech_ended(SpeakerSource::Remote,100);q.transcript(&s("What is our budget"));
        assert_eq!(q.candidate().unwrap(),"What is our budget");assert_eq!(q.confirm(300).unwrap().0,"What is our budget");
    }
    #[test]
    fn scoring_and_rhetorical_filter() {
        assert!(score("What is our launch target?", false) >= 4);
        assert!(score("Who cares?", false) < 4);
        assert!(score("We launch next week", false) < 4);
        assert_eq!(score("Can you clarify?", true), 2);
    }
    #[test]
    fn unpunctuated_rnnt_questions_qualify_but_declarations_and_rhetoric_do_not() {
        for text in ["What is our launch target for next quarter", "How do we fix this", "Can you explain the design"] {assert!(score(text,false)>=4,"{text}");}
        for text in ["What we need is another review", "Who knows", "Who cares", "We launch next week"] {assert!(score(text,false)<4,"{text}");}
    }
    #[test]
    fn punctuation_free_fixture_keeps_question_and_negative_classes() {
        let corpus: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../../tests/fixtures/utterances.json")).unwrap();
        for case in corpus {
            let text = case["text"].as_str().unwrap().trim_end_matches(['?', '.', '!']);
            assert_eq!(score(text, false) >= 4, case["question"].as_bool().unwrap(), "{text}");
        }
        for text in ["How it works is simple", "What they said was useful", "Do the work tomorrow", "Have some coffee", "Will joined our team"] {
            assert!(score(text, false) < 4, "{text}");
        }
    }
    #[test]
    fn continued_question_and_self_suppression() {
        let mut q = QuestionDetector::default();
        q.speech_started(SpeakerSource::Remote, 0);
        q.speech_ended(SpeakerSource::Remote, 100);
        q.transcript(&s("What is our launch target?"));
        assert!(q.confirm(299).is_none());
        assert!(q.confirm(300).is_some());
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
        let mut earlier_chunk = s("What is our launch target?");
        earlier_chunk.ended_at = 99;
        q.transcript(&earlier_chunk);
        assert!(q.confirm(300).is_none());
        q.speech_ended(SpeakerSource::Remote, 100);
        assert!(q.confirm(300).is_none());
        q.transcript(&s(""));
        assert_eq!(q.confirm(300).unwrap().0, "What is our launch target?");
        let mut empty = QuestionDetector::default();
        empty.speech_started(SpeakerSource::Remote, 0);
        empty.speech_ended(SpeakerSource::Remote, 100);
        empty.transcript(&s(""));
        assert!(empty.confirm(300).is_none());
    }
    #[test]
    fn streaming_final_before_vad_end_confirms_without_another_final() {
        let mut q = QuestionDetector::default();
        q.speech_started(SpeakerSource::Remote, 0);
        q.transcript(&s("What is our launch target"));
        q.speech_ended(SpeakerSource::Remote, 100);
        assert!(q.confirm(299).is_none());
        assert_eq!(q.confirm(300).unwrap().0, "What is our launch target");
        // The previous final cannot satisfy a subsequent utterance's fence.
        q.speech_started(SpeakerSource::Remote, 2000);
        q.speech_ended(SpeakerSource::Remote, 2200);
        assert!(q.confirm(2700).is_none());
        let mut next = s("How do we ship this");
        next.ended_at = 2200;
        q.transcript(&next);
        assert_eq!(q.confirm(2700).unwrap().0, "How do we ship this");
    }
}
