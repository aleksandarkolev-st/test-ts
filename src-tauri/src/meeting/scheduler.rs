//! Local burst relation detection and bounded speculative answer lifecycle.
use super::state::{CurrentQuestion, Latency};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub const BURST_MS: u64 = 200;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all="lowercase")]
pub enum Phase { Speculative, Confirmed, Superseded, Cancelled, Complete }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Row { pub id: String, pub text: String, pub state: Phase, pub queued: bool }
pub struct Job {
    pub question: CurrentQuestion, pub phase: Phase, pub running: bool,
    pub confirmed: bool, pub buffer: String, pub latency: Latency,
    pub error: Option<String>, pub cancel: CancellationToken, pub ready_at: u64,
    source_text: String,
    pub updates: tokio::sync::watch::Sender<crate::openai::codex::QuestionUpdate>,
    pub steer_supported: bool,
    context_key:Option<[u8;32]>,
}
#[derive(Default)]
pub struct Scheduler { pub jobs: Vec<Job>, pub candidate: Option<String>, pub semantic_intent: bool }
pub(crate) fn normalized(text: &str) -> String {
    text.to_lowercase().chars().map(|c|if c.is_alphanumeric(){c}else{' '}).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn related(text: &str) -> bool {
    let t=normalized(text);
    ["actually ","and actually ","instead ","i mean ","rather ","break that down", "and break", "assuming ", "with the ","also ","what about ","how about ","and "].iter().any(|p|t.starts_with(p))
}
pub(crate) fn same_question(left:&str,right:&str)->bool {
    // Whitespace may vary across ASR chunks. Signs, operators and identifier
    // case carry meaning in technical questions and must remain distinct.
    left.split_whitespace().eq(right.split_whitespace())
}
impl Job {
    pub fn set_acoustic_quiet(&mut self,quiet:bool) {
        if self.updates.borrow().acoustic_quiet==quiet{return;}
        self.updates.send_modify(|update|update.acoustic_quiet=quiet);
    }
    pub fn set_context(&mut self,context:String)->bool {
        let key=crate::openai::codex::context_key(&context);
        let changed=self.context_key!=Some(key);
        if changed && self.running && self.steer_supported {
            self.buffer.clear();self.latency.first_token_at=None;self.latency.first_word_at=None;self.latency.response_revision+=1;
        }
        self.context_key=Some(key);
        let mut update=self.updates.borrow().clone();update.context=Some(context);self.updates.send_replace(update);
        changed
    }
    pub fn accepts_stream(&self,question:&str,context_key:&[u8;32])->bool {
        same_question(question,&self.question.text)&&self.context_key.as_ref()==Some(context_key)
    }
}
impl Scheduler {
    pub fn active(&self) -> usize { self.jobs.iter().filter(|j|j.running).count() }
    pub fn busy(&self) -> bool { self.active()>0 || self.jobs.iter().any(|j|j.phase==Phase::Speculative || (j.phase==Phase::Confirmed && !j.running)) }
    pub fn find_mut(&mut self,id: &str)->Option<&mut Job>{ self.jobs.iter_mut().find(|j|j.question.id==id) }
    pub fn clear(&mut self) {for j in &self.jobs {j.cancel.cancel();} self.jobs.clear(); self.candidate=None;}
    pub fn resumed(&mut self) {
        if let Some(id)=self.candidate.take() {if let Some(j)=self.find_mut(&id){if !j.confirmed {j.phase=Phase::Cancelled;j.cancel.cancel();}}}
    }
    pub fn propose(&mut self, text: String, now: u64, stopped: u64, transcript: u64) -> String {
        self.propose_inner(text, now, stopped, transcript, false)
    }
    fn propose_inner(&mut self, text: String, now: u64, stopped: u64, transcript: u64, final_: bool) -> String {
        let semantic_intent=self.semantic_intent;
        let mut prefix=None;
        if let Some(id)=self.candidate.clone() {if let Some(j)=self.find_mut(&id) {
            if if semantic_intent{same_question(&j.source_text,&text)}else{normalized(&j.source_text)==normalized(&text)} {return id;}
            let old=normalized(&j.source_text);
            let new=normalized(&text);
            // Streaming RNNT deltas can finish a word ("la" -> "launch").
            // Requiring a space after the previous text cancels valid growth.
            let correction=!semantic_intent && new.split_whitespace().any(|word|
                ["actually","instead","rather","not"].contains(&word)
                && !old.split_whitespace().any(|previous|previous==word));
            let growing=!old.is_empty() && new.starts_with(&old) && !correction;
            if growing && (!j.running || j.steer_supported || !final_) && j.latency.completed_at.is_none() {
                if !j.running || j.steer_supported {
                    let prefix=j.question.text.strip_suffix(&j.source_text).unwrap_or("").to_owned();
                    j.question.text=format!("{prefix}{text}");j.source_text=text;
                    j.buffer.clear();j.latency.first_token_at=None;j.latency.first_word_at=None;
                    let acoustic_quiet=j.updates.borrow().acoustic_quiet;
                    j.updates.send_replace(crate::openai::codex::QuestionUpdate{acoustic_quiet,question:j.question.text.clone(),confirmed:false,context:None});
                }
                return id;
            }
            prefix=j.question.text.strip_suffix(&j.source_text).map(str::trim).filter(|s|!s.is_empty()).map(String::from);
            j.phase=Phase::Superseded; j.cancel.cancel();
        }}
        let source_text=text.clone();
        let previous=self.jobs.iter().rposition(|j|j.confirmed && matches!(j.phase,Phase::Confirmed|Phase::Complete));
        let text=if let Some(prefix)=prefix {format!("{prefix} {text}")} else if !self.semantic_intent && related(&text) {if let Some(i)=previous {
            let j=&mut self.jobs[i]; let combined=format!("{} {}",j.question.text,text);
            j.phase=Phase::Superseded;
            // A three-sentence answer with two finished sentences is nearly done.
            if j.buffer.matches(['.','!','?']).count()<2 {j.cancel.cancel();}
            combined
        } else {text}} else {text};
        // One pending burst only; newer speech supersedes an unstarted burst.
        for j in &mut self.jobs {if !j.running && matches!(j.phase,Phase::Speculative|Phase::Confirmed){j.phase=Phase::Superseded;j.cancel.cancel();}}
        let id=uuid::Uuid::new_v4().to_string();
        let ready_at=if self.active()==0 {now}else{now+BURST_MS};
        let (updates,_)=tokio::sync::watch::channel(crate::openai::codex::QuestionUpdate{acoustic_quiet:false,question:text.clone(),confirmed:false,context:None});
        self.jobs.push(Job {source_text,updates,steer_supported:false,context_key:None,question:CurrentQuestion{id:id.clone(),text,detected_at:now},phase:Phase::Speculative,running:false,confirmed:false,buffer:String::new(),error:None,cancel:CancellationToken::new(),ready_at,
            latency:Latency{speech_stopped_at:stopped,transcript_final_at:transcript,request_sent_at:now,..Default::default()}});
        self.candidate=Some(id.clone());self.prune();id
    }
    pub fn confirm(&mut self,text:String,now:u64,stopped:u64,transcript:u64)->String {
        self.confirm_with_context(text,now,stopped,transcript,None)
    }
    pub fn confirm_with_context(&mut self,text:String,now:u64,stopped:u64,transcript:u64,context:Option<String>)->String {
        // An early intent-only no-reply verdict is not a final-text verdict.
        // Re-submit the final request if that speculative job was cancelled.
        if self.candidate.as_ref().is_some_and(|id|self.jobs.iter().any(|job|job.question.id==*id&&(job.cancel.is_cancelled()||matches!(job.phase,Phase::Cancelled|Phase::Superseded)))) {self.candidate=None;}
        let id=if let Some(id)=self.candidate.clone() {
            if self.jobs.iter().any(|j|j.question.id==id && if self.semantic_intent{same_question(&j.source_text,&text)}else{normalized(&j.source_text)==normalized(&text)}) {id}
            else {self.propose_inner(text,now,stopped,transcript,true)}
        } else {self.propose_inner(text,now,stopped,transcript,true)};
        let j=self.find_mut(&id).unwrap(); j.confirmed=true;
        j.phase=if j.latency.completed_at.is_some(){Phase::Complete}else{Phase::Confirmed};
        j.latency.question_confirmed_at=now;j.latency.speech_stopped_at=stopped;j.latency.transcript_final_at=transcript;
        let context=context.or_else(||j.updates.borrow().context.clone());
        if let Some(context)=&context{j.set_context(context.clone());}
        j.updates.send_replace(crate::openai::codex::QuestionUpdate{acoustic_quiet:false,question:j.question.text.clone(),confirmed:true,context});
        self.candidate=None;
        // A third confirmed utterance must not wait behind two old Codex
        // streams. Preempt only the oldest running semantic turn, keeping the
        // more recent reply and the actual two-request concurrency limit.
        if self.active()>=2 {
            if let Some(old)=self.jobs.iter_mut().find(|old|old.question.id!=id && old.running && old.steer_supported && old.confirmed && old.phase==Phase::Confirmed && !old.cancel.is_cancelled()) {
                old.phase=Phase::Superseded;old.cancel.cancel();
            }
        }
        id
    }
    pub fn next(&mut self,now:u64)->Option<String>{
        if self.active()>=2{return None;}
        let j=self.jobs.iter_mut().find(|j|!j.running && !j.cancel.is_cancelled() && j.latency.completed_at.is_none() && now>=j.ready_at && matches!(j.phase,Phase::Speculative|Phase::Confirmed))?;
        j.running=true;Some(j.question.id.clone())
    }
    pub fn rows(&self)->Vec<Row>{self.jobs.iter().filter(|j|!matches!(j.phase,Phase::Cancelled|Phase::Superseded)).map(|j|Row{id:j.question.id.clone(),text:j.question.text.clone(),state:j.phase,queued:!j.running && j.latency.completed_at.is_none()}).collect()}
    pub fn visible(&self)->Option<&Job>{
        let ready=|j:&&Job|!j.steer_supported || !j.buffer.is_empty() || j.error.is_some();
        // Once semantic inference has produced a real answer for the latest
        // confirmed utterance, older streaming code must not hide that answer.
        self.jobs.iter().rev().filter(ready).find(|j|j.steer_supported && j.confirmed && matches!(j.phase,Phase::Confirmed|Phase::Complete))
            .or_else(||self.jobs.iter().filter(ready).find(|j|j.confirmed && j.phase==Phase::Confirmed))
            .or_else(||self.jobs.iter().rev().filter(ready).find(|j|j.confirmed && j.phase==Phase::Complete))
    }
    pub fn resume_remote_question(&mut self,question:&str,turn_started_at:Option<u64>)->Option<String> {
        if !self.semantic_intent||turn_started_at.is_none(){return None;}
        let j=self.jobs.iter_mut().rev().find(|j|j.confirmed&&j.phase==Phase::Confirmed
            &&j.latency.remote_speech_started_at==turn_started_at
            &&same_question(&j.question.text,question)&&j.latency.completed_at.is_none()
            &&!j.cancel.is_cancelled()&&(!j.running||j.steer_supported))?;
        j.confirmed=false;j.phase=Phase::Speculative;j.buffer.clear();j.latency.first_token_at=None;j.latency.first_word_at=None;
        j.latency.question_confirmed_at=0;j.latency.response_revision+=1;
        let mut update=j.updates.borrow().clone();update.confirmed=false;j.updates.send_replace(update);
        let id=j.question.id.clone();self.candidate=Some(id.clone());Some(id)
    }
    fn prune(&mut self){let latest=self.jobs.iter().rev().find(|j|j.phase==Phase::Complete).map(|j|j.question.id.clone());self.jobs.retain(|j|j.running || matches!(j.phase,Phase::Speculative|Phase::Confirmed) || latest.as_ref()==Some(&j.question.id));}
}
#[cfg(test)] mod tests {
    #[test] fn final_request_survives_an_early_no_reply_verdict() {
        let mut scheduler=Scheduler::default();scheduler.semantic_intent=true;
        let early=scheduler.propose("Explain the invariant".into(),0,0,0);
        scheduler.next(0);let job=scheduler.find_mut(&early).unwrap();job.phase=Phase::Cancelled;job.latency.completed_at=Some(30);job.running=false;
        let final_id=scheduler.confirm("Explain the invariant".into(),300,200,280);
        assert_ne!(early,final_id);assert_eq!(scheduler.next(300),Some(final_id.clone()));
        assert!(scheduler.find_mut(&final_id).unwrap().confirmed);
    }
    use super::*;
    #[test]
    fn acoustic_pause_survives_late_partial_growth_without_confirming_a_job() {
        let mut s=Scheduler{semantic_intent:true,..Default::default()};
        let id=s.propose("Evaluate both".into(),0,0,0);s.next(0);
        let j=s.find_mut(&id).unwrap();j.steer_supported=true;j.set_acoustic_quiet(true);
        s.propose("Evaluate both configurations".into(),100,0,100);
        let j=s.find_mut(&id).unwrap();
        assert!(j.updates.borrow().acoustic_quiet);assert!(!j.confirmed);
        j.set_context("Original reference".into());assert!(j.updates.borrow().acoustic_quiet);
        j.set_acoustic_quiet(false);assert!(!j.updates.borrow().acoustic_quiet);
        assert_eq!(j.question.text,"Evaluate both configurations");assert!(!j.cancel.is_cancelled());
    }
    #[test]
    fn semantic_question_identity_preserves_signs_operators_and_identifier_case() {
        assert!(same_question("Evaluate\n  value", "Evaluate value"));
        for (old,new) in [("Evaluate -1", "Evaluate 1"),("Check x < y", "Check x > y"),("Explain foo", "Explain Foo")] {
            let mut s=Scheduler{semantic_intent:true,..Default::default()};
            let id=s.propose(old.into(),0,0,0);s.next(0);
            let job=s.find_mut(&id).unwrap();job.steer_supported=true;job.set_context("Reference facts".into());job.buffer="Old answer".into();
            let corrected=s.confirm_with_context(new.into(),20,20,20,None);
            let job=s.find_mut(&corrected).unwrap();assert_eq!(job.question.text,new);assert!(job.buffer.is_empty());
            assert!(!job.accepts_stream(old,&crate::openai::codex::context_key("Reference facts")));
            assert!(!same_question(old,new));
        }
    }
    #[test]
    fn a_context_correction_clears_buffer_and_rejects_old_text_under_the_same_question() {
        let mut s=Scheduler{semantic_intent:true,..Default::default()};
        let question="What is the launch date?";
        let id=s.propose(question.into(),0,0,0);
        let old="The launch date is February 19.";
        s.find_mut(&id).unwrap().set_context(old.into());s.next(0);
        let job=s.find_mut(&id).unwrap();job.steer_supported=true;job.buffer="February 19.".into();job.latency.first_token_at=Some(10);job.latency.first_word_at=Some(10);
        let corrected="Latest correction: the date is March 22.";
        assert_eq!(s.confirm_with_context(question.into(),30,20,25,Some(corrected.into())),id);
        let job=s.find_mut(&id).unwrap();assert!(job.buffer.is_empty());assert!(job.latency.first_token_at.is_none());assert!(job.latency.first_word_at.is_none());assert_eq!(job.latency.response_revision,1);
        assert!(!job.accepts_stream(question,&crate::openai::codex::context_key(old)));
        assert!(job.accepts_stream(question,&crate::openai::codex::context_key(corrected)));
        job.buffer="March 22.".into();assert!(!job.set_context(corrected.into()));assert_eq!(job.buffer,"March 22.");
    }
    #[test]
    fn semantic_turns_keep_the_spoken_text_and_steer_corrections_without_phrase_rules() {
        let mut s=Scheduler{semantic_intent:true,..Default::default()};
        let old=s.confirm("Explain the original design".into(),0,0,0);s.next(0);
        s.find_mut(&old).unwrap().steer_supported=true;
        let current=s.propose("Also review the new plan".into(),300,300,300);
        assert_eq!(s.find_mut(&current).unwrap().question.text,"Also review the new plan");
        s.next(500);s.find_mut(&current).unwrap().steer_supported=true;
        let updated="Also review the new plan, actually assuming failure";
        assert_eq!(s.propose(updated.into(),600,300,600),current);
        let job=s.find_mut(&current).unwrap();
        assert!(!job.cancel.is_cancelled());assert_eq!(job.question.text,updated);
        assert_eq!(job.updates.borrow().question,updated);
    }
    #[test]
    fn third_confirmed_semantic_turn_preempts_oldest_stream_without_exceeding_two_requests() {
        let mut s=Scheduler::default();
        let first=s.confirm("Implement it".into(),0,0,0);s.next(0);s.find_mut(&first).unwrap().steer_supported=true;
        let second=s.confirm("Explain the invariant".into(),300,300,300);s.next(500);s.find_mut(&second).unwrap().steer_supported=true;
        let third=s.propose("Suppose the input changes".into(),600,600,600);
        assert!(!s.find_mut(&first).unwrap().cancel.is_cancelled());
        assert_eq!(s.confirm("Suppose the input changes".into(),800,600,700),third);
        assert!(s.find_mut(&first).unwrap().cancel.is_cancelled());
        assert_eq!(s.find_mut(&first).unwrap().phase,Phase::Superseded);
        assert!(!s.find_mut(&second).unwrap().cancel.is_cancelled());
        assert_eq!(s.active(),2);assert!(s.next(800).is_none());
        s.find_mut(&first).unwrap().running=false;
        assert_eq!(s.next(801),Some(third));assert_eq!(s.active(),2);
    }
    #[test]
    fn latest_semantic_reply_is_visible_while_older_code_is_still_streaming() {
        let mut s=Scheduler::default();
        let old=s.confirm("Implement it".into(),0,0,0);s.next(0);
        let job=s.find_mut(&old).unwrap();job.steer_supported=true;job.buffer="Earlier code is streaming".into();
        let new=s.confirm("Suppose the device changes".into(),1000,1000,1000);s.next(1200);
        s.find_mut(&new).unwrap().steer_supported=true;
        assert_eq!(s.visible().unwrap().question.id,old);
        s.find_mut(&new).unwrap().buffer="A useful answer to the new constraint".into();
        assert_eq!(s.visible().unwrap().question.id,new);
        s.find_mut(&old).unwrap().phase=Phase::Complete;
        assert_eq!(s.visible().unwrap().question.id,new);
    }
    #[test] fn codex_growth_preserves_one_turn_and_confirms_latest_input() {
        let mut s=Scheduler::default();let id=s.propose("What is our".into(),0,0,0);
        s.next(0);s.find_mut(&id).unwrap().steer_supported=true;
        let updates=s.find_mut(&id).unwrap().updates.subscribe();
        for (i,text) in ["What is our revenue","What is our revenue target"].iter().enumerate(){assert_eq!(s.propose((*text).into(),i as u64+10,0,0),id);}
        assert_eq!(s.confirm("What is our revenue target?".into(),200,0,100),id);
        assert_eq!(s.jobs.len(),1);assert!(!s.find_mut(&id).unwrap().cancel.is_cancelled());
        assert!(updates.borrow().confirmed);assert_eq!(normalized(&updates.borrow().question),"what is our revenue target");
    }
    #[test] fn changed_intent_cancels_even_when_it_appends_a_correction() {
        for text in ["Actually what is our hiring target", "What is our revenue target actually our hiring target"] {
            let mut s=Scheduler::default();let id=s.propose("What is our revenue target".into(),0,0,0);s.next(0);s.find_mut(&id).unwrap().steer_supported=true;
            assert_ne!(s.propose(text.into(),10,0,0),id);assert!(s.find_mut(&id).unwrap().cancel.is_cancelled());
        }
    }
    #[test] fn subword_asr_growth_preserves_the_running_turn() {
        let mut s=Scheduler::default();let id=s.propose("What is our la".into(),0,0,0);
        s.next(0);s.find_mut(&id).unwrap().steer_supported=true;
        for text in ["What is our launch", "What is our launch targ", "What is our launch target"] {
            assert_eq!(s.propose(text.into(),10,0,0),id);
        }
        assert_eq!(s.confirm("What is our launch target?".into(),200,0,100),id);
        assert_eq!(s.jobs.len(),1);assert!(!s.find_mut(&id).unwrap().cancel.is_cancelled());
        assert_ne!(s.propose("What is our hiring target".into(),210,0,0),id);
    }
    #[test] fn http_growth_restarts_only_once_at_confirmation() {
        let mut s=Scheduler::default();let id=s.propose("What is our".into(),0,0,0);s.next(0);
        assert_eq!(s.propose("What is our revenue".into(),10,0,0),id);
        assert_eq!(s.propose("What is our revenue target".into(),20,0,0),id);
        assert!(!s.find_mut(&id).unwrap().cancel.is_cancelled());
        assert_ne!(s.confirm("What is our revenue target".into(),200,0,100),id);
        assert!(s.find_mut(&id).unwrap().cancel.is_cancelled());
    }
    #[test] fn growing_followup_preserves_original_question_and_early_completion_releases(){
        let mut s=Scheduler::default();let a=s.propose("What's our revenue growth?".into(),0,0,0);s.next(0);s.confirm("What's our revenue growth?".into(),500,0,0);
        let b=s.propose("And actually break that down".into(),600,0,0);
        let c=s.propose("And actually break that down by Europe versus the US".into(),650,0,0);
        assert_eq!(b,c);
        assert_eq!(s.find_mut(&c).unwrap().question.text,"What's our revenue growth? And actually break that down by Europe versus the US");
        s.find_mut(&a).unwrap().running=false;s.next(1000);s.find_mut(&c).unwrap().latency.completed_at=Some(1050);
        s.confirm("And actually break that down by Europe versus the US".into(),1100,0,0);
        assert_eq!(s.find_mut(&c).unwrap().phase,Phase::Complete);s.find_mut(&c).unwrap().running=false;assert!(!s.busy());
    }
    #[test] fn running_prefix_growth_waits_for_final_before_restarting() {
        let mut s=Scheduler::default();
        let a=s.propose("What is our".into(),0,0,0);s.next(0);
        assert_eq!(s.propose("What is our target".into(),10,0,0),a);
        assert_eq!(s.propose("What is our target revenue".into(),20,0,0),a);
        assert!(!s.find_mut(&a).unwrap().cancel.is_cancelled());
        let b=s.confirm("What is our target revenue?".into(),500,0,500);
        assert_ne!(a,b);
        assert!(s.find_mut(&a).unwrap().cancel.is_cancelled());
        assert_eq!(s.find_mut(&b).unwrap().question.text,"What is our target revenue?");
    }
    #[test] fn queued_prefix_growth_updates_prompt_in_place() {
        let mut s=Scheduler::default();
        let a=s.propose("What is our".into(),0,0,0);
        assert_eq!(s.propose("What is our target".into(),10,0,10),a);
        assert_eq!(s.find_mut(&a).unwrap().question.text,"What is our target");
        assert_eq!(s.confirm("What is our target?".into(),500,0,500),a);
        assert!(!s.find_mut(&a).unwrap().cancel.is_cancelled());
    }
    #[test] fn bounds_buffer_and_burst(){let mut s=Scheduler::default();let a=s.propose("What is A?".into(),0,0,0);assert_eq!(s.next(0),Some(a.clone()));assert!(s.visible().is_none());s.confirm("What is A?".into(),500,0,0);let b=s.propose("What is B?".into(),510,0,0);assert!(s.next(709).is_none());assert_eq!(s.next(710),Some(b));s.confirm("What is B?".into(),1000,0,0);s.propose("What is C?".into(),1010,0,0);s.propose("What is D?".into(),1020,0,0);assert_eq!(s.active(),2);assert!(s.next(2000).is_none());assert_eq!(s.rows().iter().filter(|r|r.queued).count(),1);}
    #[test] fn correction_cancels_early_but_preserves_nearly_done(){for (buffer,cancelled) in [("early",true),("One. Two.",false)]{let mut s=Scheduler::default();let a=s.propose("What's our revenue growth?".into(),0,0,0);s.next(0);s.confirm("What's our revenue growth?".into(),500,0,0);s.find_mut(&a).unwrap().buffer=buffer.into();let b=s.propose("And actually, break that down by Europe versus the US.".into(),600,0,0);assert!(s.find_mut(&b).unwrap().question.text.contains("revenue growth"));assert_eq!(s.find_mut(&a).unwrap().cancel.is_cancelled(),cancelled);assert_eq!(s.find_mut(&a).unwrap().phase,Phase::Superseded);}}
    #[test] fn punctuation_keeps_turn_and_resumed_speech_cancels(){let mut s=Scheduler::default();let a=s.propose("What is the target".into(),0,0,0);s.next(0);assert_eq!(s.propose("What is the target?".into(),10,0,0),a);s.resumed();assert!(s.find_mut(&a).unwrap().cancel.is_cancelled());assert!(s.visible().is_none());assert_eq!(s.active(),1);}
}
