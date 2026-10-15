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
fn explicit_request_accepts_final_text_and_supersedes_without_reclassifying_intent() {
    let mut c=Scheduler::default();
    let automatic=c.confirm_with_context("A statement".into(),0,0,0,Some("First snapshot".into()));
    assert!(!c.find_mut(&automatic).unwrap().explicit_request);c.next(0);
    let draft=c.propose("Incomplete local words".into(),1,1,1);
    let explicit=c.confirm_explicit_with_context("A finalized statement".into(),2,1,1,"Exact earlier code".into());
    assert_eq!(explicit,draft);assert_ne!(explicit,automatic);
    assert!(c.find_mut(&automatic).unwrap().cancel.is_cancelled());
    let job=c.find_mut(&explicit).unwrap();assert!(job.explicit_request);assert!(job.confirmed);
    assert_eq!(job.updates.borrow().context.as_deref(),Some("Exact earlier code"));
    assert_eq!(c.next(2),Some(explicit));
}
#[test]
fn expansion_pins_parent_context_and_identity_while_a_new_transcript_is_local() {
    let mut c=Scheduler::default();
    let parent=c.confirm_with_context("Explain the exact code".into(),100,90,95,Some("Original accepted context and exact code".into()));
    let job=c.find_mut(&parent).unwrap();job.context_version=17;job.utterance_revision=3;job.latency.remote_speech_started_at=Some(80);
    job.references=Some(super::scheduler::FrozenReferences{task:std::sync::Arc::new("Pinned problem and latest test output".into()),project:std::sync::Arc::new("Original project snapshot".into()),screenshot:Some(std::sync::Arc::new("Original screenshot".into()))});
    c.next(100);c.find_mut(&parent).unwrap().buffer="An unseen later generated tail".into();
    let draft=c.propose("A later unaccepted correction".into(),110,110,110);
    let detail=c.expand(&parent,120).unwrap();
    assert_ne!(detail,parent);assert_ne!(detail,draft);
    let job=c.find_mut(&detail).unwrap();assert!(job.detailed);assert!(job.explicit_request);assert_eq!(job.parent_generation_id.as_deref(),Some(parent.as_str()));
    assert_eq!(job.context_version,17);assert_eq!(job.utterance_revision,3);assert_eq!(job.latency.remote_speech_started_at,Some(80));
    assert_eq!(job.updates.borrow().context.as_deref(),Some("Original accepted context and exact code"));
    assert_eq!(job.references.as_ref().unwrap().project.as_str(),"Original project snapshot");
    assert_eq!(job.references.as_ref().unwrap().task.as_str(),"Pinned problem and latest test output");
    assert_eq!(job.references.as_ref().unwrap().screenshot.as_ref().unwrap().as_str(),"Original screenshot");
    assert!(c.find_mut(&parent).unwrap().cancel.is_cancelled());assert_eq!(c.next(120),Some(detail));assert_eq!(c.active(),2);
}
#[test]
fn delayed_expansion_cannot_reactivate_an_old_parent_or_cancel_new_focus() {
    let mut c=Scheduler::default();let old=c.confirm_with_context("Earlier question".into(),0,0,0,Some("Old context".into()));
    c.next(0);let current=c.confirm_with_context("New focus".into(),10,10,10,Some("New context".into()));
    let count=c.jobs.len();assert!(c.expand(&old,11).is_none());assert_eq!(c.jobs.len(),count);
    assert_eq!(c.visible().unwrap().question.id,current);assert!(!c.find_mut(&current).unwrap().cancel.is_cancelled());
}
#[test]
fn expansion_requires_a_frozen_parent_snapshot_and_supports_completed_parents() {
    let mut c=Scheduler::default();let parent=c.confirm("Question".into(),0,0,0);
    assert!(c.expand(&parent,1).is_none());
    let job=c.find_mut(&parent).unwrap();job.set_context("Frozen source".into());
    assert!(c.expand(&parent,1).is_none());
    let job=c.find_mut(&parent).unwrap();job.references=Some(super::scheduler::FrozenReferences::default());job.phase=Phase::Complete;job.latency.completed_at=Some(2);
    let detail=c.expand(&parent,3).unwrap();assert_eq!(c.visible().unwrap().question.id,detail);
    assert_eq!(c.next(3),Some(detail.clone()));
    let newer=c.confirm_with_context("Interrupt detail".into(),4,4,4,Some("Latest source".into()));
    assert!(c.find_mut(&detail).unwrap().cancel.is_cancelled());assert_eq!(c.visible().unwrap().question.id,newer);
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
fn clipped_and_late_paint_ranges_never_become_previously_seen_text() {
    let mut ledger=super::ledger::Ledger::default();
    ledger.generated("old","Explain","Opening. Clipped middle. Late tail.");
    assert!(ledger.acknowledge_paint("old","Opening. Clipped middle. Late tail.",0,8,100));
    assert!(ledger.acknowledge_paint("old","Opening. Clipped middle. Late tail.",25,35,300));
    let early=ledger.context("Why?",Some(200));assert!(early.contains("Opening."));
    assert!(!early.contains("Clipped middle"));assert!(!early.contains("Late tail"));
    let later=ledger.context("Recall",Some(400));assert!(later.contains("Late tail."));
    assert!(!later.contains("Clipped middle"));assert!(later.contains("undisplayed gap"));
    assert_eq!(ledger.suggestions[0].generated,"Opening. Clipped middle. Late tail.");
    assert!(!ledger.acknowledge_paint("old","Forged",0,6,100));
}
#[test]
fn exact_archived_code_retrieval_does_not_present_unseen_tail_to_live_followup() {
    let mut ledger=super::ledger::Ledger::default();
    let code="```cpp\nint OriginalGuard(int x) { return x < -1 ? 17 : 19; }\n```";
    ledger.generated("code","Implement OriginalGuard",code);
    assert!(!ledger.context("Recall OriginalGuard",Some(200)).contains("return x"));
    ledger.terminal("code",300,true);
    assert!(!ledger.context("Recall OriginalGuard",Some(200)).contains("return x"));
    let retrieved=ledger.context("Recall exact OriginalGuard",Some(400));
    assert!(retrieved.contains(code));assert!(retrieved.contains("not evidence of speech or viewport visibility"));
    assert!(!ledger.context("Why?",Some(400)).contains("return x"));
    assert!(ledger.acknowledge_paint("code",code,0,code.len(),350));
    assert_eq!(ledger.context("Recall OriginalGuard",Some(400)).matches(code).count(),1);
}
#[test]
fn growing_paint_history_references_source_once_instead_of_copying_prefixes() {
    let mut ledger=super::ledger::Ledger::default();
    let text="x".repeat(32_000);ledger.generated("a","Explain",&text);
    for end in 1..=32_000 {assert!(ledger.acknowledge_paint("a",&text,0,end,end as u64));}
    assert_eq!(ledger.suggestions[0].generated.len(),32_000);
    assert_eq!(ledger.suggestions[0].painted_ranges.len(),32_000);
    assert_eq!(std::mem::size_of_val(&ledger.suggestions[0].painted_ranges[0]),24);
    assert!(ledger.context("Why?",Some(16_001)).contains(&"x".repeat(16_000)));
    assert!(!ledger.context("Why?",Some(16_001)).contains(&"x".repeat(16_001)));
}
#[test]
fn archived_code_preserves_literal_fence_markers_and_crlf_without_reconstruction() {
    let mut ledger=super::ledger::Ledger::default();
    let exact="````cpp\r\nconst char* MarkerText() { return \"``` literal ~~~\"; }\r\n````\r\n";
    ledger.generated("literal","Implement MarkerText",exact);ledger.terminal("literal",100,true);
    let context=ledger.context("Recall exact MarkerText",Some(200));
    assert!(context.contains(exact));assert_eq!(context.matches(exact).count(),1);
    assert_eq!(ledger.suggestions[0].generated,exact);
}
#[test]
fn archived_tilde_fences_are_exact_and_incomplete_fences_do_not_become_complete_code() {
    let mut ledger=super::ledger::Ledger::default();
    let exact="~~~rust\nfn TildeValue() -> i32 { 17 }\n~~~";
    ledger.generated("tilde","Implement TildeValue",exact);ledger.terminal("tilde",100,false);
    assert!(ledger.context("Recall TildeValue",Some(200)).contains(exact));
    let incomplete="````cpp\nint PartialValue() { return 19; }\n```";
    ledger.generated("partial","Implement PartialValue",incomplete);ledger.terminal("partial",110,false);
    assert!(!ledger.context("Recall PartialValue",Some(200)).contains("int PartialValue"));
    assert_eq!(ledger.suggestions[1].generated,incomplete);
}
#[test]
fn only_painted_prefix_enters_followup_context_and_retired_history_survives() {
    let mut ledger=super::ledger::Ledger::default();
    ledger.generated("old","Explain the invariant","Visible opening. Unseen tail.");
    assert!(!ledger.context("Why?",Some(200)).contains("Visible opening"));
    assert!(!ledger.acknowledge_display("old","Invented answer",100));
    assert!(ledger.acknowledge_display("old","Visible opening.",100));
    ledger.terminal("old",150,false);
    ledger.generated("current","Why?","Current reasoning.");
    // This IPC arrived after the interruption but describes a later paint.
    assert!(ledger.acknowledge_display("old","Visible opening. Unseen tail.",300));
    let pinned=ledger.context("Why?",Some(200));
    assert!(pinned.contains("Visible opening."));assert!(!pinned.contains("Unseen tail"));
    assert!(!pinned.contains("Current reasoning"));
    assert!(ledger.context("Recall the earlier answer",Some(400)).contains("Unseen tail"));
    assert!(!ledger.acknowledge_display("old","Visible opening.",100));
    assert!(!ledger.acknowledge_display("missing","Visible opening.",100));
    assert_eq!(ledger.suggestions[0].interrupted_at,Some(150));
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
    use sha2::{Digest,Sha256};
    let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/candidate-replacement-exhaustion.json")).unwrap();
    let waveform=include_bytes!("../../../tests/fixtures/candidate-replacement-exhaustion.wav");
    assert_eq!(format!("{:x}",Sha256::digest(waveform)),fixture["waveSha256"].as_str().unwrap());
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

#[test]
fn undecided_automatic_bursts_bound_capacity_without_cancelling_foreground() {
    let mut c=Scheduler::default();let parent=c.confirm("Foreground opaque text".into(),100,90,95);c.next(100);
    let first=c.confirm_automatic_with_context("First candidate".into(),200,180,190,None);c.next(200);
    let first_cancel=c.find_mut(&first).unwrap().cancel.clone();
    let mut last=String::new();
    for now in 201..240 {
        last=c.confirm_automatic_with_context(format!("Arbitrary candidate {now}"),now,now,now,None);
        assert!(c.next(now).is_none());assert_eq!(c.active(),2);
        assert!(!c.find_mut(&parent).unwrap().cancel.is_cancelled());
        assert_eq!(c.rows().iter().filter(|r|r.queued).count(),1);
    }
    assert!(first_cancel.is_cancelled());c.find_mut(&first).unwrap().running=false;
    assert_eq!(c.next(240),Some(last.clone()));assert_eq!(c.active(),2);
    assert!(c.authorize_answer(&last,250));assert!(c.find_mut(&parent).unwrap().cancel.is_cancelled());
}
#[test]
fn undecided_capacity_failure_is_visible_without_destroying_foreground_work() {
    let mut c=Scheduler::default();let parent=c.confirm("Existing work".into(),100,90,95);c.next(100);
    c.confirm_automatic_with_context("First opaque input".into(),200,180,190,None);c.next(200);
    let last=c.confirm_automatic_with_context("Latest opaque input".into(),300,280,290,None);
    assert!(c.next(300+RECOVERY_MS).is_none());assert!(c.latest_request_error().is_some());
    assert!(!c.find_mut(&parent).unwrap().cancel.is_cancelled());assert_eq!(c.visible().unwrap().question.id,parent);
    assert_eq!(c.find_mut(&last).unwrap().latency.question_confirmed_at,300);
    assert_eq!(c.active(),2);
}
#[test]
fn undecided_failure_pruning_and_explicit_preemption_preserve_completed_foreground() {
    let mut c=Scheduler::default();let parent=c.confirm("Completed foreground".into(),100,90,95);
    let old=c.find_mut(&parent).unwrap();old.phase=Phase::Complete;old.latency.completed_at=Some(150);old.buffer="Exact old answer".into();
    let bad=c.confirm_automatic_with_context("Failed candidate".into(),200,180,190,None);
    let j=c.find_mut(&bad).unwrap();j.phase=Phase::Complete;j.latency.completed_at=Some(250);j.error=Some("Transport error".into());
    c.propose("New local revision".into(),300,280,290);
    assert_eq!(c.visible().unwrap().question.id,parent);assert_eq!(c.visible().unwrap().buffer,"Exact old answer");
    let explicit=c.confirm_explicit_with_context("Explicit next task".into(),310,300,305,"Frozen explicit context".into());
    assert_eq!(c.visible().unwrap().question.id,explicit);assert_eq!(c.visible().unwrap().focus_authorized_at,Some(310));
    assert_eq!(c.next(310),Some(explicit));
}


fn grow_recognized_retrieval_budget(ledger:&mut super::ledger::Ledger) {
    let after=ledger.recognized.iter().map(|r|r.segment.ended_at).max().unwrap_or(0);
    for turn in 1..=32 {
        ledger.displayed(&format!("budget-{turn}"),"Independent subsequent discussion",
            &"independent unrelated discussion. ".repeat(400),after+turn*1000);
    }
}
#[test]
fn recognized_utterance_retrieval_keeps_pronoun_clauses_atomic_beyond_budget() {
    // Opaque subjects vary; retrieval policy has no knowledge of their names.
    for seed in [3u32,29,107,65537] {
        let mut ledger=super::ledger::Ledger::default();
        let subject=format!("subject_{seed:08x}");
        let decision=format!("{subject} retains records for {} days.",seed+1);
        ledger.observe(speech("subject-clause",&decision,10),110);
        ledger.observe(speech("owner-clause","The owner of it is the second attendee.",120),220);
        ledger.observe(speech("unrelated-clause","A separate decision belongs to someone else.",230),330);
        grow_recognized_retrieval_budget(&mut ledger);
        let before=ledger.context(&subject,None);
        assert!(before.contains(&decision));assert!(!before.contains("owner-clause"));
        ledger.associate_remote_utterance(10,["subject-clause","owner-clause"]);
        let after=ledger.context(&subject,None);
        assert!(after.contains("Derived context view"));assert!(after.contains(&decision));
        assert!(after.contains("REMOTE [utterance owner-clause, revision 1, 120..220 ms]: The owner of it is the second attendee."));
        assert!(!after.contains("unrelated-clause"));
        assert_eq!(ledger.recognized.len(),3);
    }
}
#[test]
fn recognized_groups_preserve_latest_revision_and_every_original() {
    let mut ledger=super::ledger::Ledger::default();
    let original="const char* identifier = \"exact_α\";\r\n";
    let corrected="const char* identifier = \"exact_β\";\r\n";
    ledger.observe(speech("code",original,10),110);
    ledger.observe(speech("owner","It belongs to the earlier speaker.",120),220);
    ledger.associate_remote_utterance(10,["code","owner"]);
    ledger.observe(speech("code",corrected,10),230);
    grow_recognized_retrieval_budget(&mut ledger);
    let view=ledger.context("identifier",None);
    assert!(view.contains(corrected));assert!(!view.contains(original));
    assert!(view.contains("REMOTE [utterance code, revision 2"));assert!(view.contains("utterance owner"));
    assert_eq!(ledger.recognized[0].segment.text,original);
    assert_eq!(ledger.recognized[2].segment.text,corrected);
    assert_eq!(ledger.recognized.len(),3);
}
#[test]
fn unrelated_adjacent_speech_and_other_speaker_are_not_inferred_into_groups() {
    let mut ledger=super::ledger::Ledger::default();
    ledger.observe(speech("same-id","Earlier project declaration.",10),110);
    let mut own=speech("same-id","Separate microphone fact.",11);own.source=SpeakerSource::Self_;
    ledger.observe(own,111);ledger.observe(speech("next-id","Unrelated adjacent speech.",12),112);
    ledger.associate_remote_utterance(10,["same-id","unknown-id"]);
    let view=ledger.context("Recall",None);
    let group=view.split("RECOGNIZED UTTERANCE").nth(1).unwrap().split("\n\n").next().unwrap();
    assert!(group.contains("REMOTE [utterance same-id"));
    assert!(!group.contains("microphone fact"));assert!(!group.contains("next-id"));
    assert!(!view.contains("unknown-id"));assert!(view.contains("SELF [utterance same-id"));
}
#[test]
fn existing_source_membership_cannot_be_moved_by_a_late_association() {
    let mut ledger=super::ledger::Ledger::default();
    ledger.observe(speech("original","The original subject.",10),110);
    ledger.observe(speech("later","Different later subject.",1000),1100);
    ledger.associate_remote_utterance(10,["original"]);let version=ledger.version;
    ledger.associate_remote_utterance(1000,["original"]);assert_eq!(ledger.version,version);
    ledger.associate_remote_utterance(1000,["later"]);
    let view=ledger.context("Recall",None);
    let old=view.split("controller floor 10 ms").nth(1).unwrap().split("\n\n").next().unwrap();
    assert!(old.contains("utterance original"));assert!(!old.contains("utterance later"));
}
#[test]
fn grouped_context_cutoff_excludes_future_source_clauses() {
    let mut ledger=super::ledger::Ledger::default();
    ledger.observe(speech("early","Eligible earlier statement.",10),110);
    ledger.observe(speech("late","Future statement must stay absent.",200),300);
    ledger.associate_remote_utterance(10,["early","late"]);
    let view=ledger.context("Recall",Some(200));
    assert!(view.contains("Eligible earlier statement."));assert!(!view.contains("Future statement"));
    assert!(ledger.context("Recall",Some(301)).contains("Future statement"));
    assert_eq!(ledger.recognized.len(),2);
}
#[test]
fn oversized_recognized_group_is_omitted_whole_without_losing_originals() {
    let mut ledger=super::ledger::Ledger::default();
    ledger.observe(speech("oversized",&format!("opaque_subject {}","z".repeat(240_001)),10),110);
    ledger.observe(speech("linked","It has this associated condition.",120),220);
    ledger.associate_remote_utterance(10,["oversized","linked"]);
    let view=ledger.context("opaque_subject",None);
    assert!(view.contains("Derived context view"));assert!(!view.contains("utterance oversized"));
    assert!(!view.contains("utterance linked"));assert_eq!(ledger.recognized.len(),2);
    assert!(ledger.recognized[0].segment.text.len()>240_000);
}
#[test]
fn computation_cancellation_keeps_recognized_groups_until_session_clear() {
    let mut memory=MeetingContext::default();let mut c=Scheduler::default();
    memory.ledger.observe(speech("first","A retained subject.",10),110);
    memory.ledger.observe(speech("second","It has an exact condition.",120),220);
    memory.ledger.associate_remote_utterance(10,["first","second"]);
    let old=c.confirm("Earlier request".into(),300,290,295);c.next(300);
    c.confirm("Interrupt request".into(),400,390,395);assert!(c.find_mut(&old).unwrap().cancel.is_cancelled());
    let view=memory.ledger.context("Recall",None);
    assert!(view.contains("utterance first"));assert!(view.contains("utterance second"));
    memory.clear();assert!(memory.ledger.recognized.is_empty());
    assert!(!memory.ledger.context("Recall",None).contains("controller floor"));
}
#[test]
fn detector_exposes_exact_final_ids_across_pause_and_confirmation_but_not_new_floor() {
    let mut detector=QuestionDetector::default();detector.semantic_intent=true;detector.conversation_endpoints=true;
    detector.speech_started(SpeakerSource::Remote,100);
    detector.transcript(&speech("clause-one","An earlier recognized clause.",100));
    detector.speech_ended(SpeakerSource::Remote,200);
    assert!(detector.speech_started(SpeakerSource::Remote,300));
    detector.transcript(&speech("clause-two","Its subsequent condition.",300));
    detector.speech_ended(SpeakerSource::Remote,400);assert!(detector.confirm_now(400).is_some());
    assert_eq!(detector.recognized_segment_ids().collect::<Vec<_>>(),vec!["clause-one","clause-two"]);
    detector.transcript(&speech("clause-two","Its corrected condition.",300));
    assert_eq!(detector.recognized_segment_ids().collect::<Vec<_>>(),vec!["clause-one","clause-two"]);
    assert!(detector.confirm_now(450).is_some());
    assert!(!detector.speech_started(SpeakerSource::Remote,500));
    assert!(detector.recognized_segment_ids().next().is_none());
    let mut partial=speech("partial","Unfinished",500);partial.final_=false;detector.transcript(&partial);
    assert!(detector.recognized_segment_ids().next().is_none());
}

#[test]
fn recorded_recognized_floor_keeps_the_omitted_source_clause_retrievable() {
    let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/controller-recognized-source-group-v73.json")).unwrap();
    let mut detector=QuestionDetector::default();
    detector.semantic_intent=true;detector.independent_asr_endpoint=true;detector.conversation_endpoints=true;
    let mut ledger=super::ledger::Ledger::default();
    let base=fixture["hostToNativeOffset"].as_u64().unwrap();
    for event in fixture["events"].as_array().unwrap() {
        let p=&event["payload"];
        match event["name"].as_str().unwrap() {
            "speech.started"=>{detector.speech_started(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap());},
            "speech.ended"=>detector.speech_ended(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap()),
            "speech.activity"=>detector.speech_activity(SpeakerSource::Remote,p["timestamp"].as_u64().unwrap(),p["quiet"].as_bool().unwrap()),
            "transcript"=>{let segment:TranscriptSegment=serde_json::from_value(p.clone()).unwrap();
                ledger.observe(segment.clone(),event["receivedHostMs"].as_u64().unwrap()-base);detector.transcript(&segment);},
            _=>panic!("Unexpected recorded fixture event")
        }
    }
    let now=fixture["confirmedAt"].as_u64().unwrap();
    let (question,_)=detector.confirm(now).expect("Recorded complete recognized utterance remains acceptable");
    assert_eq!(question,fixture["expectedRecognizedRequest"].as_str().unwrap());
    assert_eq!(detector.remote_turn_started_at,fixture["expectedFloor"].as_u64());
    let expected=fixture["expectedSegmentIds"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(detector.recognized_segment_ids().collect::<Vec<_>>(),expected);
    grow_recognized_retrieval_budget(&mut ledger);
    let query=fixture["recallQuestion"].as_str().unwrap();
    let omitted_id=fixture["omittedSourceId"].as_str().unwrap();
    assert!(!ledger.context(query,None).contains(omitted_id));
    ledger.associate_remote_utterance(detector.remote_turn_started_at.unwrap(),detector.recognized_segment_ids());
    let view=ledger.context(query,None);
    assert!(view.contains("Derived context view"));
    assert!(view.contains(omitted_id));assert!(view.contains(fixture["omittedSourceText"].as_str().unwrap()));
    for id in expected {assert!(view.contains(id));}
    assert_eq!(ledger.recognized.len(),fixture["expectedSegmentIds"].as_array().unwrap().len());
}
