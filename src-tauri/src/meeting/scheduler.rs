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
}
#[derive(Default)]
pub struct Scheduler { pub jobs: Vec<Job>, pub candidate: Option<String> }
pub(crate) fn normalized(text: &str) -> String {
    text.to_lowercase().chars().map(|c|if c.is_alphanumeric(){c}else{' '}).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn related(text: &str) -> bool {
    let t=normalized(text);
    ["actually ","and actually ","instead ","i mean ","rather ","break that down", "and break", "assuming ", "with the ","also ","what about ","how about ","and "].iter().any(|p|t.starts_with(p))
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
        let mut prefix=None;
        if let Some(id)=self.candidate.clone() {if let Some(j)=self.find_mut(&id) {
            if normalized(&j.source_text)==normalized(&text) {return id;}
            let old=normalized(&j.source_text);
            let new=normalized(&text);
            // Streaming RNNT deltas can finish a word ("la" -> "launch").
            // Requiring a space after the previous text cancels valid growth.
            let correction=new.split_whitespace().any(|word|
                ["actually","instead","rather","not"].contains(&word)
                && !old.split_whitespace().any(|previous|previous==word));
            let growing=!old.is_empty() && new.starts_with(&old) && !correction;
            if growing && (!j.running || j.steer_supported || !final_) && j.latency.completed_at.is_none() {
                if !j.running || j.steer_supported {
                    let prefix=j.question.text.strip_suffix(&j.source_text).unwrap_or("").to_owned();
                    j.question.text=format!("{prefix}{text}");j.source_text=text;
                    j.buffer.clear();j.latency.first_token_at=None;
                    j.updates.send_replace(crate::openai::codex::QuestionUpdate{question:j.question.text.clone(),confirmed:false,context:None});
                }
                return id;
            }
            prefix=j.question.text.strip_suffix(&j.source_text).map(str::trim).filter(|s|!s.is_empty()).map(String::from);
            j.phase=Phase::Superseded; j.cancel.cancel();
        }}
        let source_text=text.clone();
        let previous=self.jobs.iter().rposition(|j|j.confirmed && matches!(j.phase,Phase::Confirmed|Phase::Complete));
        let text=if let Some(prefix)=prefix {format!("{prefix} {text}")} else if related(&text) {if let Some(i)=previous {
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
        let (updates,_)=tokio::sync::watch::channel(crate::openai::codex::QuestionUpdate{question:text.clone(),confirmed:false,context:None});
        self.jobs.push(Job {source_text,updates,steer_supported:false,question:CurrentQuestion{id:id.clone(),text,detected_at:now},phase:Phase::Speculative,running:false,confirmed:false,buffer:String::new(),error:None,cancel:CancellationToken::new(),ready_at,
            latency:Latency{speech_stopped_at:stopped,transcript_final_at:transcript,request_sent_at:now,..Default::default()}});
        self.candidate=Some(id.clone());self.prune();id
    }
    pub fn confirm(&mut self,text:String,now:u64,stopped:u64,transcript:u64)->String {
        self.confirm_with_context(text,now,stopped,transcript,None)
    }
    pub fn confirm_with_context(&mut self,text:String,now:u64,stopped:u64,transcript:u64,context:Option<String>)->String {
        let id=if let Some(id)=self.candidate.clone() {
            if self.jobs.iter().any(|j|j.question.id==id && normalized(&j.source_text)==normalized(&text)) {id}
            else {self.propose_inner(text,now,stopped,transcript,true)}
        } else {self.propose_inner(text,now,stopped,transcript,true)};
        let j=self.find_mut(&id).unwrap(); j.confirmed=true;
        j.phase=if j.latency.completed_at.is_some(){Phase::Complete}else{Phase::Confirmed};
        j.latency.question_confirmed_at=now;j.latency.speech_stopped_at=stopped;j.latency.transcript_final_at=transcript;
        j.updates.send_replace(crate::openai::codex::QuestionUpdate{question:j.question.text.clone(),confirmed:true,context});
        self.candidate=None;id
    }
    pub fn next(&mut self,now:u64)->Option<String>{
        if self.active()>=2{return None;}
        let j=self.jobs.iter_mut().find(|j|!j.running && !j.cancel.is_cancelled() && j.latency.completed_at.is_none() && now>=j.ready_at && matches!(j.phase,Phase::Speculative|Phase::Confirmed))?;
        j.running=true;Some(j.question.id.clone())
    }
    pub fn rows(&self)->Vec<Row>{self.jobs.iter().filter(|j|!matches!(j.phase,Phase::Cancelled|Phase::Superseded)).map(|j|Row{id:j.question.id.clone(),text:j.question.text.clone(),state:j.phase,queued:!j.running && j.latency.completed_at.is_none()}).collect()}
    pub fn visible(&self)->Option<&Job>{self.jobs.iter().find(|j|j.confirmed && j.phase==Phase::Confirmed).or_else(||self.jobs.iter().rev().find(|j|j.confirmed && j.phase==Phase::Complete))}
    fn prune(&mut self){let latest=self.jobs.iter().rev().find(|j|j.phase==Phase::Complete).map(|j|j.question.id.clone());self.jobs.retain(|j|j.running || matches!(j.phase,Phase::Speculative|Phase::Confirmed) || latest.as_ref()==Some(&j.question.id));}
}
#[cfg(test)] mod tests {
    use super::*;
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
    #[test] fn bounds_buffer_and_burst(){let mut s=Scheduler::default();let a=s.propose("What is A?".into(),0,0,0);assert_eq!(s.next(0),Some(a.clone()));assert!(s.visible().is_none());s.confirm("What is A?".into(),500,0,0);let b=s.propose("What is B?".into(),510,0,0);assert!(s.next(709).is_none());assert_eq!(s.next(710),Some(b));s.confirm("What is B?".into(),1000,0,0);s.propose("What is C?".into(),1010,0,0);s.propose("What is D?".into(),1020,0,0);assert_eq!(s.active(),2);assert!(s.next(2000).is_none());assert_eq!(s.rows().iter().filter(|r|r.queued).count(),1);}
    #[test] fn correction_cancels_early_but_preserves_nearly_done(){for (buffer,cancelled) in [("early",true),("One. Two.",false)]{let mut s=Scheduler::default();let a=s.propose("What's our revenue growth?".into(),0,0,0);s.next(0);s.confirm("What's our revenue growth?".into(),500,0,0);s.find_mut(&a).unwrap().buffer=buffer.into();let b=s.propose("And actually, break that down by Europe versus the US.".into(),600,0,0);assert!(s.find_mut(&b).unwrap().question.text.contains("revenue growth"));assert_eq!(s.find_mut(&a).unwrap().cancel.is_cancelled(),cancelled);assert_eq!(s.find_mut(&a).unwrap().phase,Phase::Superseded);}}
    #[test] fn punctuation_keeps_turn_and_resumed_speech_cancels(){let mut s=Scheduler::default();let a=s.propose("What is the target".into(),0,0,0);s.next(0);assert_eq!(s.propose("What is the target?".into(),10,0,0),a);s.resumed();assert!(s.find_mut(&a).unwrap().cancel.is_cancelled());assert!(s.visible().is_none());assert_eq!(s.active(),1);}
}
