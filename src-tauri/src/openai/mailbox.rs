//! Bounded, lossless per-request accumulation. A stalled consumer cannot block
//! the shared protocol reader. Overflow is an explicit request failure.
use serde_json::{json,Value};
use std::{collections::VecDeque,sync::{Arc,Mutex}};
use tokio::sync::Notify;
struct State {queue:VecDeque<(Value,usize)>,bytes:usize,closed:bool,overflow:bool}
struct Shared {state:Mutex<State>,notify:Notify,soft_capacity:usize,byte_limit:usize}
#[derive(Clone)]
pub struct Sender(Arc<Shared>);
pub struct Receiver(Arc<Shared>);
pub fn channel(soft_capacity:usize)->(Sender,Receiver) {channel_with_limit(soft_capacity,4*1024*1024)}
fn channel_with_limit(soft_capacity:usize,byte_limit:usize)->(Sender,Receiver) {
    let shared=Arc::new(Shared{state:Mutex::new(State{queue:VecDeque::new(),bytes:0,closed:false,overflow:false}),notify:Notify::new(),soft_capacity,byte_limit});
    (Sender(shared.clone()),Receiver(shared))
}
impl Sender {
    pub fn try_send(&self,value:Value)->Result<(),String> {
        let bytes=serde_json::to_vec(&value).map_err(|_|"Invalid protocol message")?.len();
        let mut state=self.0.state.lock().unwrap();
        if state.closed||state.overflow{return Err("Answer consumer closed or exceeded accumulation limit".into());}
        if state.bytes+bytes>self.0.byte_limit {state.overflow=true;drop(state);self.0.notify.notify_one();return Err("Answer accumulation exceeds 4 MiB; current generation failed explicitly".into());}
        state.bytes+=bytes;state.queue.push_back((value,bytes));drop(state);self.0.notify.notify_one();Ok(())
    }
    pub fn capacity(&self)->usize {self.0.soft_capacity.saturating_sub(self.0.state.lock().unwrap().queue.len())}
    pub fn max_capacity(&self)->usize {self.0.soft_capacity}
}
impl Receiver {
    pub fn len(&self)->usize {self.0.state.lock().unwrap().queue.len()}
    pub async fn recv(&mut self)->Option<Value> {
        loop {
            // Register before checking the queue to avoid a lost wakeup.
            let notified=self.0.notify.notified();tokio::pin!(notified);notified.as_mut().enable();
            {
                let mut state=self.0.state.lock().unwrap();
                if state.overflow {state.overflow=false;state.closed=true;return Some(json!({"method":"copilot/overflow"}));}
                if let Some((message,bytes))=state.queue.pop_front(){state.bytes-=bytes;return Some(message);}
                if state.closed{return None;}
            }
            notified.await;
        }
    }
}
impl Drop for Receiver {fn drop(&mut self){let mut state=self.0.state.lock().unwrap();state.closed=true;state.queue.clear();state.bytes=0;}}
#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test] async fn slow_consumer_retains_every_delta_in_order() {
        let (tx,mut rx)=channel(1);for i in 0..1000{tx.try_send(json!({"delta":i})).unwrap();}
        for i in 0..1000{assert_eq!(rx.recv().await.unwrap()["delta"],i);}
    }
    #[tokio::test] async fn overflow_is_visible_and_bounded() {
        let (tx,mut rx)=channel_with_limit(1,64);tx.try_send(json!({"delta":"first"})).unwrap();
        assert!(tx.try_send(json!({"delta":"x".repeat(100)})).is_err());
        assert_eq!(rx.recv().await.unwrap()["method"],"copilot/overflow");
        assert_eq!(rx.recv().await.unwrap()["delta"],"first");assert!(rx.recv().await.is_none());
    }
}
