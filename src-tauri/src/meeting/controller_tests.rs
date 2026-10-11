//! Regressions for the production controller, separate from baseline contracts.
use super::{scheduler::{Scheduler,Phase,RECOVERY_MS},context::{MeetingContext,Memory},questions::QuestionDetector,SpeakerSource,TranscriptSegment};
fn speech(id:&str,text:&str,at:u64)->TranscriptSegment {TranscriptSegment{id:id.into(),source:SpeakerSource::Remote,text:text.into(),started_at:at,ended_at:at+100,final_:true}}
#[test]
fn revisions_are_local_and_do_not_spend_final_request_eligibility() {
    let mut controller=Scheduler::default();
    let id=controller.propose("Explain".into(),0,0,0);
    for revision in 1..100 {assert_eq!(controller.propose(format!("Explain revision {revision}"),revision,revision,revision),id);assert!(controller.next(revision).is_none());}
    let final_id=controller.confirm_with_context("Explain X".into(),100,90,95,Some("Exact preceding exchange".into()));
    assert_eq!(final_id,id);assert_eq!(controller.next(100),Some(id.clone()));
    assert!(controller.jobs[0].updates.borrow().confirmed);assert_eq!(controller.jobs[0].generation_id,id);
}
#[test]
fn why_during_output_preempts_without_waiting_for_an_obsolete_echo() {
    let mut c=Scheduler::default();let old=c.confirm("Explain X".into(),0,0,0);c.next(0);c.find_mut(&old).unwrap().buffer="Exact displayed opening".into();
    let new=c.confirm("Why?".into(),10,9,9);
    assert_ne!(old,new);assert!(c.find_mut(&old).unwrap().cancel.is_cancelled());
    assert_eq!(c.visible().unwrap().question.id,new);assert!(c.visible().unwrap().buffer.is_empty());
    assert_eq!(c.next(10),Some(new));assert_eq!(c.active(),2);
}
#[test]
fn repeated_interruptions_bound_retirement_and_keep_only_latest_pending_intent() {
    let mut c=Scheduler::default();let a=c.confirm("A".into(),0,0,0);c.next(0);let b=c.confirm("B".into(),1,1,1);c.next(1);
    let mut latest=String::new();for now in 2..100{latest=c.confirm(format!("Correction {now}"),now,now,now);assert!(c.next(now).is_none());assert_eq!(c.active(),2);assert_eq!(c.rows().iter().filter(|r|r.queued).count(),1);}
    c.find_mut(&a).unwrap().running=false;assert_eq!(c.next(100),Some(latest));assert!(c.find_mut(&b).unwrap().cancel.is_cancelled());
}
#[test]
fn capacity_failure_is_explicit_and_does_not_claim_warm_dispatch_success() {
    let mut c=Scheduler::default();c.confirm("A".into(),0,0,0);c.next(0);c.confirm("B".into(),1,1,1);c.next(1);c.confirm("C".into(),2,2,2);
    assert!(c.next(RECOVERY_MS+2).is_none());assert!(c.visible().unwrap().error.is_some());assert_eq!(c.visible().unwrap().phase,Phase::Complete);
    c.jobs.iter_mut().for_each(|job|job.running=false);
    let final_=c.confirm("C corrected".into(),3000,3000,3000);assert_eq!(c.next(3000),Some(final_));
}
#[test]
fn memory_preserves_recognition_revisions_exact_code_and_interrupted_display() {
    let mut memory=MeetingContext::default();
    memory.ledger.observe(speech("utterance","Use count=17",0),100);
    memory.ledger.observe(speech("utterance","Use count=19",0),110);
    let code="```cpp\nint Foo(int x) { return x < -1 ? 17 : 19; }\n```";
    memory.ledger.generated("code","Implement Foo",code);memory.ledger.displayed("code","Implement Foo",code,150);memory.ledger.terminal("code",200,false);
    for i in 1..=25 {memory.push(speech(&format!("turn-{i}"),&format!("Unrelated decision {i}"),i*1000));}
    memory.complete_summary(Memory{summary:"A lossy summary".into(),..Default::default()});
    let prompt=memory.answer_context("Recall the exact Foo source from turn one");assert!(prompt.contains(code));assert!(prompt.contains("count=19"));
    assert_eq!(memory.ledger.recognized.len(),27);assert_eq!(memory.ledger.recognized[0].segment.text,"Use count=17");assert_eq!(memory.ledger.suggestions[0].interrupted_at,Some(200));
    assert!(!prompt.contains("A lossy summary"));memory.clear();assert!(memory.ledger.recognized.is_empty());
}
#[test]
fn unseen_tail_cannot_retroactively_change_the_followup_reference() {
    let mut memory=MeetingContext::default();memory.ledger.displayed("a","Explain X","Opening seen.",100);
    let frozen=memory.answer_context_for_utterance("Why?",Some(200));
    memory.ledger.generated("a","Explain X","A late generated tail.");memory.ledger.displayed("a","Explain X","Opening seen. A late generated tail.",300);
    assert_eq!(memory.answer_context_for_utterance("Why?",Some(200)),frozen);assert!(!frozen.contains("late generated tail"));
    assert!(memory.answer_context_for_utterance("What if?",Some(400)).contains("late generated tail"));
}
#[test]
fn exact_old_code_is_retrieved_whole_beyond_the_prompt_budget() {
    let mut memory=MeetingContext::default();
    let code="```cpp\nint Foo_17(int x) { return x < -1 ? 17 : 19; }\n```";
    memory.ledger.displayed("original","Implement Foo_17",code,1);
    for i in 1..=30 {memory.ledger.displayed(&format!("padding-{i}"),"Unrelated discussion",&"Unrelated discussion. ".repeat(1000),i*1000);}
    let prompt=memory.answer_context("Repeat exact original Foo_17 code");
    assert!(prompt.contains(code));assert!(prompt.contains("Derived context view"));
    assert!(prompt.len()<241_000);assert_eq!(memory.ledger.suggestions.len(),31);
}
#[test]
fn late_acceptance_has_a_distinct_revision_but_a_new_floor_starts_at_zero() {
    let mut ledger=super::ledger::Ledger::default();
    assert_eq!(ledger.accepted_revision(10),0);assert_eq!(ledger.accepted_revision(10),1);
    assert_eq!(ledger.accepted_revision(20),0);assert_eq!(ledger.accepted_revision(10),2);
}
#[test]
fn multipart_pause_and_short_followup_use_independent_acceptance() {
    let mut d=QuestionDetector::default();d.semantic_intent=true;d.conversation_endpoints=true;
    d.speech_started(SpeakerSource::Remote,0);d.transcript(&speech("a","Explain all constraints on the design including overflow and",0));d.speech_ended(SpeakerSource::Remote,100);
    assert!(d.confirm(1600).is_none());assert!(d.speech_started(SpeakerSource::Remote,1600));
    d.transcript(&speech("b","reject invalid input",1600));d.speech_ended(SpeakerSource::Remote,1700);
    assert!(d.confirm(3499).is_none());assert!(d.confirm(3500).unwrap().0.ends_with("reject invalid input"));
    assert!(!d.speech_started(SpeakerSource::Remote,3700));d.transcript(&speech("c","Why",3700));d.speech_ended(SpeakerSource::Remote,3800);
    assert_eq!(d.confirm(4000).unwrap().0,"Why");
}
#[test]
fn late_final_correction_replaces_recognition_without_repeating_the_utterance() {
    let mut detector=QuestionDetector::default();detector.semantic_intent=true;detector.conversation_endpoints=true;
    detector.speech_started(SpeakerSource::Remote,0);detector.transcript(&speech("u","Evaluate Foo < -1",0));detector.speech_ended(SpeakerSource::Remote,100);
    assert_eq!(detector.confirm(300).unwrap().0,"Evaluate Foo < -1");
    detector.transcript(&speech("u","Evaluate Foo > -1",0));
    assert_eq!(detector.confirm(400).unwrap().0,"Evaluate Foo > -1");
    assert!(!detector.transcript(&speech("u","Evaluate Foo > -1",0)));assert!(detector.confirm(500).is_none());
}
#[test]
fn hour_long_archive_and_application_clock_are_independent() {
    let mut memory=MeetingContext::default();let mut controller=Scheduler::default();
    for i in 0..3600 {memory.push(speech(&i.to_string(),&format!("Speaker's exact fact {i}"),i*1000));let id=controller.confirm(format!("Question {i}"),i*1000,i*1000,i*1000);assert_eq!(controller.next(i*1000),Some(id.clone()));let job=controller.find_mut(&id).unwrap();job.running=false;job.phase=Phase::Complete;job.latency.completed_at=Some(i*1000+1);}
    assert_eq!(memory.ledger.recognized.len(),3600);assert_eq!(memory.ledger.recognized[0].segment.text,"Speaker's exact fact 0");
    let id=controller.confirm("Why?".into(),3_600_000,3_600_000,3_600_000);assert_eq!(controller.next(3_600_000),Some(id));
    assert!(controller.jobs.len()<=2);
}
#[test]
fn candidate_failed_waveform_final_frame_remains_eligible() {
    let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/candidate-replacement-exhaustion.json")).unwrap();
    assert_eq!(fixture["failure"],"Codex question replacement budget exhausted");
    assert_eq!(fixture["events"].as_array().unwrap().iter().filter(|e|e["name"]=="question.confirmed").count(),11);
    let mut detector=QuestionDetector::default();detector.semantic_intent=true;detector.independent_asr_endpoint=true;detector.conversation_endpoints=true;
    let mut controller=Scheduler::default();let mut memory=MeetingContext::default();
    let events=fixture["events"].as_array().unwrap();
    let base=events[0]["receivedHostMs"].as_u64().unwrap()-events[0]["payload"]["timestamp"].as_u64().unwrap();
    let mut accepted=Vec::new();let mut now=0;
    for event in events {
        let received=event["receivedHostMs"].as_u64().unwrap()-base;
        while now<received {
            if let Some((question,stop))=detector.confirm(now) {
                let context=memory.answer_context_for_utterance(&question,detector.remote_turn_started_at);
                let id=controller.confirm_with_context(question,now,stop,now,Some(context));accepted.push(id.clone());
                assert_eq!(controller.next(now),Some(id.clone()));
                // Controlled terminal proof; no obsolete input echo is injected.
                let job=controller.find_mut(&id).unwrap();job.running=false;job.phase=Phase::Complete;job.latency.completed_at=Some(now+1);
            }
            now+=20;
        }
        let p=&event["payload"];
        match event["name"].as_str().unwrap() {
            "speech.started"=>{detector.speech_started(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap());},
            "speech.ended"=>detector.speech_ended(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap()),
            "speech.activity"=>detector.speech_activity(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap(),p["quiet"].as_bool().unwrap()),
            "transcript"=>{let segment:TranscriptSegment=serde_json::from_value(p.clone()).unwrap();memory.ledger.observe(segment.clone(),now);detector.transcript(&segment);},_=>{}
        }
    }
    if let Some((question,stop))=detector.confirm(now+3000) {
        let context=memory.answer_context_for_utterance(&question,detector.remote_turn_started_at);
        let id=controller.confirm_with_context(question,now+3000,stop,now,Some(context));assert_eq!(controller.next(now+3000),Some(id.clone()));accepted.push(id);
    }
    assert!(!accepted.is_empty());let last=controller.jobs.iter().find(|job|job.question.id==*accepted.last().unwrap()).unwrap();
    let frame=format!("{} {}",last.updates.borrow().context.as_deref().unwrap(),last.question.text);
    assert!(frame.to_lowercase().contains("what experiment distinguishes them"));
    assert!(frame.to_lowercase().contains("conductance"));assert!(last.error.is_none());
}
