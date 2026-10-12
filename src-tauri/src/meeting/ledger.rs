//! Authoritative, RAM-only source ledger. Derived prompts never mutate it.
use super::{SpeakerSource,TranscriptSegment};
use std::collections::HashMap;
#[derive(Clone,Debug)]
pub struct Recognition {pub segment:TranscriptSegment,pub revision:u64,pub observed_at:u64}
#[derive(Clone,Default,Debug)]
pub struct Suggestion {
    pub id:String,pub question:String,pub generated:String,
    pub displayed:Vec<(u64,String)>,pub completed_at:Option<u64>,pub interrupted_at:Option<u64>,
    pub display_versions:Vec<Vec<(u64,String)>>,
    // Observations reference the immutable exact source; never copy growing
    // text on every paint (which would make retained memory quadratic).
    pub painted_ranges:Vec<(u64,usize,usize)>,
}
#[derive(Default)]
pub struct Ledger {
    pub recognized:Vec<Recognition>,pub suggestions:Vec<Suggestion>,pub version:u64,
    pub accepted:Vec<(String,String,u64)>,
    pub typed_requests:Vec<(String,String,u64)>,
    revisions:HashMap<(String,String),u64>,
    request_revisions:HashMap<u64,u64>,
}
impl Ledger {
    pub fn accepted_revision(&mut self,utterance:u64)->u64 {
        let next=self.request_revisions.entry(utterance).or_default();
        let revision=*next;*next+=1;revision
    }
    pub fn accept(&mut self,id:&str,question:&str,now:u64) {
        if !self.accepted.iter().any(|(previous,_,_)|previous==id){self.accepted.push((id.into(),question.into(),now));self.version+=1;}
    }
    pub fn typed(&mut self,id:&str,question:&str,now:u64) {self.accept(id,question,now);self.typed_requests.push((id.into(),question.into(),now));}
    pub fn observe(&mut self,segment:TranscriptSegment,now:u64) {
        let source=label(segment.source).to_owned();
        let revision=self.revisions.entry((source,segment.id.clone())).or_default();*revision+=1;
        self.recognized.push(Recognition{segment,revision:*revision,observed_at:now});self.version+=1;
    }
    fn suggestion(&mut self,id:&str,question:&str)->&mut Suggestion {
        if let Some(index)=self.suggestions.iter().position(|s|s.id==id){return &mut self.suggestions[index];}
        self.suggestions.push(Suggestion{id:id.into(),question:question.into(),..Default::default()});self.suggestions.last_mut().unwrap()
    }
    pub fn generated(&mut self,id:&str,question:&str,delta:&str) {self.suggestion(id,question).generated.push_str(delta);self.version+=1;}
    /// Renderer evidence, independent of delivery to the renderer. Delayed
    /// acknowledgements may belong to a retired generation; retain that history
    /// without authorizing it to replace the current panel. Never invent text.
    pub fn acknowledge_display(&mut self,id:&str,text:&str,now:u64)->bool {
        let Some(s)=self.suggestions.iter().find(|s|s.id==id) else{return false;};
        if text.is_empty()||!s.generated.starts_with(text){return false;}
        let previous=s.displayed.iter().map(|(_,delta)|delta.as_str()).collect::<String>();
        // Out-of-order IPC acknowledgements cannot roll history back.
        if !text.starts_with(&previous){return false;}
        let question=s.question.clone();self.displayed(id,&question,text,now);true
    }
    pub fn acknowledge_paint(&mut self,id:&str,text:&str,start:usize,end:usize,now:u64)->bool {
        let Some(s)=self.suggestions.iter_mut().find(|s|s.id==id) else{return false;};
        if start>=end||end>text.len()||!text.is_char_boundary(start)||!text.is_char_boundary(end)||!s.generated.starts_with(text){return false;}
        if !s.painted_ranges.last().is_some_and(|(_,previous_start,previous_end)|*previous_start==start&&*previous_end==end){
            s.painted_ranges.push((now,start,end));self.version+=1;
        }
        true
    }
    pub fn displayed(&mut self,id:&str,question:&str,text:&str,now:u64) {
        let suggestion=self.suggestion(id,question);
        let previous=suggestion.displayed.iter().map(|(_,delta)|delta.as_str()).collect::<String>();
        if text==previous{return;}
        // A generation is immutable: rewriting displayed text is a new version,
        // never a destructive edit of what a person already saw.
        if let Some(delta)=text.strip_prefix(&previous) {suggestion.displayed.push((now,delta.into()));}
        else {suggestion.display_versions.push(std::mem::take(&mut suggestion.displayed));suggestion.displayed.push((now,text.into()));}
        self.version+=1;
    }
    pub fn terminal(&mut self,id:&str,now:u64,completed:bool) {
        if let Some(s)=self.suggestions.iter_mut().find(|s|s.id==id){if completed{s.completed_at=Some(now);}else{s.interrupted_at=Some(now);}self.version+=1;}
    }
    /// Chronological originals once while they fit. The cutoff pins exactly
    /// what had been displayed when speech began; unseen generated tails are
    /// never presented to a contextual follow-up as previously seen answers.
    pub fn context(&self,question:&str,started:Option<u64>)->String {
        let cutoff=started.unwrap_or(u64::MAX);
        let mut items:Vec<(u64,String)>=Vec::new();
        for (id,text,at) in &self.typed_requests {if *at<cutoff {items.push((*at,format!("USER TYPED REQUEST [generation {id}]: {text}")));}}
        let mut latest=HashMap::new();
        for record in &self.recognized {
            if record.segment.final_ && !(record.segment.source==SpeakerSource::Remote&&record.segment.started_at>=cutoff) {
                latest.insert((label(record.segment.source),record.segment.id.as_str()),record);
            }
        }
        for record in latest.values() {
            items.push((record.segment.started_at,format!("{} [utterance {}, revision {}, {}..{} ms]: {}",label(record.segment.source),record.segment.id,record.revision,record.segment.started_at,record.segment.ended_at,record.segment.text)));
        }
        for suggestion in &self.suggestions {
            // Exact code is a stable archived source, even if the viewport
            // clipped part of it. Literal identifier retrieval is generic and
            // locally bounded; it never predicts a question or reconstructs
            // code. A current/late generated tail is ineligible at the cutoff.
            if suggestion.completed_at.or(suggestion.interrupted_at).is_some_and(|at|at<cutoff){
                let query=question.split(|c:char|!c.is_alphanumeric()&&c!='_').filter(|word|word.len()>=3).map(|word|word.to_lowercase()).collect::<Vec<_>>();
                for exact in closed_code_fences(&suggestion.generated){
                    let matches=exact.split(|c:char|!c.is_alphanumeric()&&c!='_').any(|identifier|query.iter().any(|word|word==&identifier.to_lowercase()));
                    let already_visible=suggestion.painted_ranges.iter().any(|(at,start,end)|*at<cutoff&&suggestion.generated[*start..*end].contains(exact))||suggestion.displayed.iter().filter(|(at,_)|*at<cutoff).map(|(_,text)|text.as_str()).collect::<String>().contains(exact);
                    if matches&&!already_visible {
                        items.push((suggestion.completed_at.or(suggestion.interrupted_at).unwrap(),format!("ARCHIVED EXACT GENERATED CODE [generation {}; may be incorrect; not evidence of speech or viewport visibility]\nQUESTION: {}\n{exact}",suggestion.id,suggestion.question)));
                    }
                }
            }
            let mut ranges=suggestion.painted_ranges.iter().filter(|(at,_,_)|*at<cutoff).collect::<Vec<_>>();
            if !ranges.is_empty(){
                let first=ranges.iter().map(|(at,_,_)|*at).min().unwrap();
                ranges.sort_by_key(|(_,start,_)|*start);
                let mut merged:Vec<(usize,usize)>=Vec::new();
                for (_,start,end) in ranges {
                    if let Some(previous)=merged.last_mut().filter(|(_,previous_end)|*start<=*previous_end){previous.1=previous.1.max(*end);}
                    else{merged.push((*start,*end));}
                }
                let text=merged.into_iter().map(|(start,end)|format!("[visible source bytes {start}..{end}]\n{}",&suggestion.generated[start..end])).collect::<Vec<_>>().join("\n[undisplayed gap]\n");
                items.push((first,format!("COPILOT SUGGESTION [generation {}; may be unfinished or incorrect]\nQUESTION: {}\nEXACT DISPLAYED TEXT:\n{}",suggestion.id,suggestion.question,text)));
                continue;
            }
            let displayed=suggestion.display_versions.iter().chain(std::iter::once(&suggestion.displayed)).rev().find(|version|version.first().is_some_and(|(at,_)|*at<cutoff));
            if let Some(displayed)=displayed {
                let text=displayed.iter().filter(|(at,_)|*at<cutoff).map(|(_,delta)|delta.as_str()).collect::<String>();
                if !text.is_empty(){items.push((displayed[0].0,format!("COPILOT SUGGESTION [generation {}; may be unfinished or incorrect]\nQUESTION: {}\nEXACT DISPLAYED TEXT:\n{}",suggestion.id,suggestion.question,text)));}
            }
        }
        items.sort_by(|a,b|a.0.cmp(&b.0).then_with(||a.1.cmp(&b.1)));
        const LIMIT:usize=240_000;
        let total:usize=items.iter().map(|(_,text)|text.len()).sum();
        if total>LIMIT {
            // Retrieve whole source items, including complete code. No source
            // deletion and no code slicing. Explicitly expose omitted material.
            let query=question.split(|c:char|!c.is_alphanumeric()&&c!='_').filter(|word|word.len()>2).map(|word|word.to_lowercase()).collect::<Vec<_>>();
            let recent=items.len().saturating_sub(16);
            let immediate=items.len().saturating_sub(2);
            // Pin the immediate exchange first, then rank source contents by
            // literal query overlap. Provenance labels do not count as matches.
            // Preserve whole versions: no code reconstruction or slicing.
            let mut ranked=items.into_iter().enumerate().map(|(i,item)|{
                let source=item.1.split_once("EXACT DISPLAYED TEXT:\n").map_or(item.1.as_str(),|(_,text)|text).to_lowercase();
                let score=query.iter().filter(|word|source.contains(word.as_str())).map(|word|word.len()).sum::<usize>();
                (i,item,score)
            }).collect::<Vec<_>>();
            ranked.sort_by(|a,b|(b.0>=immediate).cmp(&(a.0>=immediate)).then_with(||b.2.cmp(&a.2)).then_with(||b.0.cmp(&a.0)));
            let mut used=0;
            items=ranked.into_iter().filter_map(|(i,item,score)|{
                if (i>=recent||score>0)&&used+item.1.len()<=LIMIT {used+=item.1.len();Some(item)}else{None}
            }).collect();items.sort_by(|a,b|a.0.cmp(&b.0).then_with(||a.1.cmp(&b.1)));
            items.insert(0,(0,"[Derived context view: older originals remain in the session archive; some are outside this request's context budget. Ask for the exact source if absent.]".into()));
        }
        format!("ORDERED SESSION SOURCES (recognized speech and displayed suggestions are distinct)\n{}",items.into_iter().map(|(_,text)|text).collect::<Vec<_>>().join("\n\n"))
    }
}
fn label(source:SpeakerSource)->&'static str {match source{SpeakerSource::Remote=>"REMOTE",SpeakerSource::Self_=>"SELF"}}

/// Return exact closed source slices. Literal backticks inside code do not
/// delimit a fence; the closing marker must occupy its own line and be at
/// least as long as the opening marker. Incomplete sources stay in the ledger.
fn closed_code_fences(source:&str)->Vec<&str> {
    let mut fences=Vec::new();let mut open:Option<(u8,usize,usize)>=None;let mut offset=0;
    for line in source.split_inclusive('\n') {
        let content=line.trim_end_matches(|c|c=='\r'||c=='\n');
        let indent=content.bytes().take_while(|c|*c==b' ').count();
        if indent<=3 {
            let rest=&content[indent..];
            if let Some(marker)=rest.as_bytes().first().copied().filter(|c|*c==b'`'||*c==b'~') {
                let length=rest.bytes().take_while(|c|*c==marker).count();
                if let Some((expected,minimum,start))=open {
                    if marker==expected&&length>=minimum&&rest[length..].trim().is_empty(){
                        fences.push(&source[start..offset+line.len()]);open=None;
                    }
                }else if length>=3&&(marker!=b'`'||!rest[length..].contains('`')) {
                    open=Some((marker,length,offset));
                }
            }
        }
        offset+=line.len();
    }
    fences
}
