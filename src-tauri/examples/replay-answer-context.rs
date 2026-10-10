//! Offline reconstruction of context from retained journal rows, never routing.
use meeting_copilot_core::meeting::{context::MeetingContext, SpeakerSource, TranscriptSegment};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::Write, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    assert_eq!(args.len(),3,"JOURNAL TARGET_ROUND OUTPUT");
    let root=std::env::current_dir()?.canonicalize()?;
    let source=PathBuf::from(&args[0]).canonicalize()?;assert!(source.starts_with(&root));
    let output=root.join(&args[2]);assert!(output.parent().unwrap().canonicalize()?.starts_with(&root));
    let target=args[1].parse::<u64>()?;
    let bytes=fs::read(&source)?;let journal:Value=serde_json::from_slice(&bytes)?;
    let rows=journal["rows"].as_array().ok_or("Missing rows")?;
    let target_row=rows.iter().find(|row|row["round"].as_u64()==Some(target)).ok_or("Missing target round")?;
    let floor=target_row["latency"]["remoteSpeechStartedAt"].as_u64().ok_or("Missing target floor")?;
    let question=target_row["recognizedQuestion"].as_str().ok_or("Missing target recognized question")?;
    let mut context=MeetingContext::default();let mut prior=Vec::new();
    for row in rows.iter().filter(|row|row["round"].as_u64().is_some_and(|round|round<target)) {
        if row["ignored"].as_bool()==Some(true)||row["latency"]["completedAt"].as_u64().is_none(){continue;}
        let round=row["round"].as_u64().ok_or("Missing prior round")?;
        let text=row["recognizedQuestion"].as_str().ok_or("Missing prior transcript")?;
        let answer=row["answer"].as_str().ok_or("Missing prior answer")?;
        let start=row["latency"]["remoteSpeechStartedAt"].as_u64().ok_or("Missing prior floor")?;
        let end=row["speechEndNativeMs"].as_u64().ok_or("Missing prior speech end")?;
        let id=row["responseVersion"].as_str().ok_or("Missing response version")?.split(':').next().unwrap();
        let order=row["latency"]["pipeline"]["candidateDetected"].as_u64()
            .or_else(||row["latency"]["questionConfirmedAt"].as_u64()).ok_or("Missing prior order")?;
        context.push(TranscriptSegment{id:format!("replay-{round}"),source:SpeakerSource::Remote,
            text:text.into(),started_at:start,ended_at:end,final_:true});
        context.remember_answer_at(id,text,answer,order);
        prior.push((round,answer));
    }
    let selected=context.answer_context_for_utterance(question,Some(floor));
    let classifier=context.classifier_context(floor);
    let record=json!({"scope":"Reconstruction from retained completed public rows using current context code. It excludes unreported intermediate answers, live partial transcripts and actual compression summaries; it is not an exact captured model prompt or proof of a failure's cause. No phrases, domains or replay examples enter production routing.",
        "sourceSha256":format!("{:x}",Sha256::digest(&bytes)),"sourceStatus":journal["status"],"targetRound":target,
        "question":question,"answerContextChars":selected.chars().count(),"answerContextSha256":format!("{:x}",Sha256::digest(selected.as_bytes())),
        "classifierContextChars":classifier.chars().count(),"priorAnswers":prior.into_iter().map(|(round,answer)|json!({"round":round,
            "answerChars":answer.chars().count(),"completeAnswerPresent":selected.contains(answer),"closedTripleBacktickCount":answer.matches("```").count()})).collect::<Vec<_>>()});
    let mut file=OpenOptions::new().write(true).create_new(true).open(output)?;
    file.write_all(serde_json::to_string_pretty(&record)?.as_bytes())?;
    println!("{}",serde_json::to_string(&record)?);Ok(())
}
