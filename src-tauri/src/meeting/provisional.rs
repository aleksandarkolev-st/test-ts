//! Acceptance-only observations. Never authorizes display or semantic reuse.
use serde_json::{json,Value};

#[derive(Default)]
pub struct Prefix {
    frame:Option<(String,[u8;32])>,
    text:String,
    first_word:Option<u64>,
    revision:u64,
}
impl Prefix {
    pub fn reset(&mut self){self.frame=None;self.text.clear();self.first_word=None;self.revision+=1;}
    pub fn observe(&mut self,question:&str,key:[u8;32],delta:&str,now:u64)->Option<Value>{
        if self.frame.as_ref().is_some_and(|(q,k)|q!=question||*k!=key){self.reset();}
        self.frame=Some((question.into(),key));
        let remaining=256usize.saturating_sub(self.text.chars().count());
        if remaining==0{return None;}
        let piece:String=delta.chars().take(remaining).collect();
        if piece.chars().any(char::is_alphanumeric){self.first_word.get_or_insert(now);}
        self.text.push_str(&piece);
        Some(json!({"question":question,"contextKey":key,"prefix":self.text,
            "revision":self.revision,"observedAt":now,"firstWordObservedAt":self.first_word,
            "capChars":256,"atCap":self.text.chars().count()==256,
            "scope":"Unvalidated decoded prefix: not display authorization, retained-answer timing, or proof of semantic validity."}))
    }
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn unicode_prefix_bounds_and_revision_timing_do_not_reuse_old_observations(){
        let mut prefix=Prefix::default();
        assert!(prefix.observe("First",[0;32]," ```",10).unwrap()["firstWordObservedAt"].is_null());
        assert_eq!(prefix.observe("First",[0;32],"π",20).unwrap()["firstWordObservedAt"],20);
        let capped=prefix.observe("First",[0;32],&"λ".repeat(300),30).unwrap();
        assert_eq!(capped["prefix"].as_str().unwrap().chars().count(),256);
        assert!(prefix.observe("First",[0;32],"obsolete",40).is_none());
        let changed=prefix.observe("Corrected",[1;32],"Next",50).unwrap();
        assert_eq!(changed["firstWordObservedAt"],50);assert_eq!(changed["prefix"],"Next");
        prefix.reset();assert_eq!(prefix.observe("Corrected",[1;32],"New",60).unwrap()["firstWordObservedAt"],60);
    }
}
