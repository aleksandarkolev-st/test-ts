//! Persistent Responses socket. Failed/cancelled transactions discard the socket
//! so the next caller cannot receive output from a different question.
use super::{client::StreamEvent, timing::{Stage, Trace}};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpStream, sync::{watch, Mutex}};
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message}, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

pub type Update = super::codex::QuestionUpdate;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
#[derive(Default)]
pub struct ResponsesSocket { state: Mutex<Option<Connection>> }
struct Connection { socket: Socket, auth: String, warm: Option<(Value, String)> }
impl ResponsesSocket {
    async fn connect(token: &str, cancel: &CancellationToken) -> Result<Connection, String> {
        let mut request = "wss://api.openai.com/v1/responses".into_client_request().map_err(|_| "Invalid Responses endpoint")?;
        request.headers_mut().insert("authorization", format!("Bearer {token}").parse().map_err(|_| "Invalid API credential")?);
        let (socket, _) = tokio::select! {
            _=cancel.cancelled()=>return Err("cancelled".into()),
            result=tokio::time::timeout(std::time::Duration::from_secs(10),connect_async(request))=>result.map_err(|_|"Responses connection timed out")?.map_err(|_|"Responses connection failed")?
        };
        Ok(Connection { socket, auth: token.into(), warm: None })
    }
    pub async fn prewarm(&self, mut body: Value, token: &str, cancel: &CancellationToken) -> Result<(), String> {
        let mut state = tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),state=self.state.lock()=>state};
        let mut connection = match state.take().filter(|c|c.auth==token) { Some(c)=>c, None=>Self::connect(token,cancel).await? };
        let key = body.clone();
        body.as_object_mut().ok_or("Invalid Responses request")?.remove("stream");
        body["type"]=json!("response.create"); body["generate"]=json!(false);
        send(&mut connection.socket,&body,cancel).await?;
        loop {
            let event=receive(&mut connection.socket,cancel).await?;
            match event["type"].as_str() {
                Some("response.completed")=>{
                    let id=event["response"]["id"].as_str().ok_or("Missing warm response id")?.to_owned();
                    connection.warm=Some((key,id)); *state=Some(connection);return Ok(());
                },
                Some("error"|"response.failed"|"response.incomplete")=>return Err("Responses warmup failed".into()), _=>{}
            }
        }
    }
    pub async fn stream<F,Fut>(&self,mut body:Value,token:&str,cancel:CancellationToken,mut updates:Option<watch::Receiver<Update>>,trace:Option<Trace>,mut event:F)->Result<(),String>
    where F:FnMut(StreamEvent)->Fut+Send,Fut:std::future::Future<Output=Result<(),String>>+Send {
        if let Some(t)=&trace {t.backend("websocket");t.mark(Stage::StreamEntered);}
        let mut state=tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),state=self.state.lock()=>state};
        if let Some(t)=&trace {t.mark(Stage::SemaphoreAcquired);}
        let mut connection=match state.take().filter(|c|c.auth==token) {Some(c)=>c,None=>Self::connect(token,&cancel).await?};
        if let Some((warm,id))=connection.warm.take() {
            if warm["model"]==body["model"] && warm["instructions"]==body["instructions"] {
                body["previous_response_id"]=json!(id);if let Some(t)=&trace{t.warmed();}
            }
        }
        body.as_object_mut().ok_or("Invalid Responses request")?.remove("stream");body["type"]=json!("response.create");
        send(&mut connection.socket,&body,&cancel).await?;
        if let Some(t)=&trace{t.request_sent();t.mark(Stage::TurnStartSent);}
        let mut active_question=updates.as_ref().map(|r|r.borrow().question.clone()).unwrap_or_default();
        let mut response_id=String::new();
        loop {
            let value=receive(&mut connection.socket,&cancel).await?;
            match value["type"].as_str() {
                Some("response.created")=>{response_id=value["response"]["id"].as_str().unwrap_or_default().into();if let Some(t)=&trace{t.created();t.mark(Stage::TurnStartAck);}},
                Some("response.output_text.delta")=>{
                    if let Some(delta)=value["delta"].as_str(){if let Some(t)=&trace{t.mark(Stage::FirstAgentDelta);}event(StreamEvent::Delta(delta.into())).await?;}
                },
                Some("response.completed")=>{
                    if let Some(t)=&trace{t.response_metadata(&value["response"]);t.mark(Stage::TurnCompleted);}
                    if let Some(receiver)=updates.as_mut() {
                        while !receiver.borrow().confirmed {
                            tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),changed=receiver.changed()=>changed.map_err(|_|"Question update channel closed")?};
                        }
                        let latest=receiver.borrow_and_update().clone();
                        if super::super::meeting::scheduler::normalized(&active_question)!=super::super::meeting::scheduler::normalized(&latest.question) {
                            active_question=latest.question.clone();
                            event(StreamEvent::Revision(String::new())).await?;
                            body["previous_response_id"]=json!(response_id);
                            body["input"]=json!([{"role":"user","content":format!("{}\nCURRENT QUESTION\n{}",latest.context.unwrap_or_default(),latest.question)}]);
                            send(&mut connection.socket,&body,&cancel).await?;continue;
                        }
                    }
                    event(StreamEvent::Completed).await?;*state=Some(connection);return Ok(());
                },
                Some("error"|"response.failed"|"response.incomplete")=>return Err("Responses socket answer failed".into()),_=>{}
            }
        }
    }
}
async fn send(socket:&mut Socket,value:&Value,cancel:&CancellationToken)->Result<(),String>{
    tokio::select!{_=cancel.cancelled()=>Err("cancelled".into()),result=tokio::time::timeout(std::time::Duration::from_secs(10),socket.send(Message::Text(value.to_string().into())))=>result.map_err(|_|"Responses write timed out")?.map_err(|_|"Responses socket write failed".into())}
}
async fn receive(socket:&mut Socket,cancel:&CancellationToken)->Result<Value,String>{
    loop {
        let message=tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),result=tokio::time::timeout(std::time::Duration::from_secs(120),socket.next())=>result.map_err(|_|"Responses answer timed out")?.ok_or("Responses socket closed")?.map_err(|_|"Responses socket read failed")?};
        match message {Message::Text(text)=>return serde_json::from_str(&text).map_err(|_|"Invalid Responses socket event".into()),Message::Close(_)=>return Err("Responses socket closed".into()),_=>{}}
    }
}
