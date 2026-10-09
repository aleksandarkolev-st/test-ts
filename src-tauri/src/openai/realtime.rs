//! Optional direct API text response transport; the signed-in path uses Codex.
use super::client::StreamEvent;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::{connect_async,tungstenite::{client::IntoClientRequest,Message}};
use tokio_util::sync::CancellationToken;
pub async fn stream<F,Fut>(token:&str,model:&str,instructions:&str,input:&str,cancel:CancellationToken,mut event:F)->Result<(),String>
where F:FnMut(StreamEvent)->Fut+Send,Fut:std::future::Future<Output=Result<(),String>>+Send {
    let url=format!("wss://api.openai.com/v1/realtime?model={}",url::form_urlencoded::byte_serialize(model.as_bytes()).collect::<String>());
    let mut request=url.into_client_request().map_err(|_|"Invalid Realtime endpoint")?;
    request.headers_mut().insert("authorization",format!("Bearer {token}").parse().map_err(|_|"Invalid API credential")?);
    let (mut socket,_)=tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),result=tokio::time::timeout(std::time::Duration::from_secs(10),connect_async(request))=>result.map_err(|_|"Realtime connection timed out")?.map_err(|_|"Realtime connection failed")?};
    for value in [json!({"type":"session.update","session":{"type":"realtime","output_modalities":["text"],"instructions":instructions}}),json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":input}]}}),json!({"type":"response.create","response":{"output_modalities":["text"]}})] {
        tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),result=socket.send(Message::Text(value.to_string().into()))=>result.map_err(|_|"Realtime write failed")?};
    }
    loop {
        let message=tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),result=tokio::time::timeout(std::time::Duration::from_secs(120),socket.next())=>result.map_err(|_|"Realtime answer timed out")?.ok_or("Realtime socket closed")?.map_err(|_|"Realtime read failed")?};
        if let Message::Text(text)=message {
            let value:serde_json::Value=serde_json::from_str(&text).map_err(|_|"Invalid Realtime event")?;
            match value["type"].as_str(){Some("response.output_text.delta")=>{if let Some(d)=value["delta"].as_str(){event(StreamEvent::Delta(d.into())).await?;}},Some("response.done")=>{if value["response"]["status"]!="completed"{return Err("Realtime response failed".into());}event(StreamEvent::Completed).await?;return Ok(());},Some("error")=>return Err("Realtime request failed".into()),_=>{}}
        } else if matches!(message,Message::Close(_)){return Err("Realtime socket closed".into());}
    }
}
