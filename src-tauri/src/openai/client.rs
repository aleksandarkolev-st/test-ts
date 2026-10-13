use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}
pub fn parse_models(v: serde_json::Value) -> Result<Vec<Model>, String> {
    let rows = v
        .get("models")
        .and_then(|m| m.as_array())
        .ok_or("Account returned no model catalog")?;
    let models = rows
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            Some(Model {
                slug: m["slug"].as_str()?.into(),
                display_name: m["display_name"].as_str()?.into(),
            })
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        Err("No models are available for this ChatGPT account".into())
    } else {
        Ok(models)
    }
}
pub fn preferred(models: &[Model]) -> Option<&Model> {
    models
        .iter()
        .find(|m| {
            let s = m.slug.to_lowercase();
            (s.contains("mini") || s.contains("nano") || s.contains("luna")) && !s.contains("pro")
        })
        .or_else(|| {
            models
                .iter()
                .find(|m| m.slug.contains("sol") && !m.slug.contains("pro"))
        })
        .or_else(|| models.first())
}
#[derive(Clone)]
pub struct Client {
    pub responses_ws: std::sync::Arc<super::responses_ws::ResponsesSocket>,
    trace: Option<super::timing::Trace>,
    refill_policy: super::codex::RefillPolicy,
    pub http: reqwest::Client,
    // Shared by clones, including summary/attachment calls. Unknown remote
    // retirement continues to consume capacity after its local stream closes.
    http_slots: std::sync::Arc<tokio::sync::Semaphore>,
    base: String,
    reasoning_effort: Option<String>,
    backend: AnswerBackend,
    service_tier: Option<String>,
    // Per-request framing; clones retain the warm pool and concurrency limit.
    // Ordinary text/summary requests must remain free-form.
    reply_schema: Option<serde_json::Value>,
    pub codex: Option<std::sync::Arc<super::codex::Codex>>,
}
struct AbortHttpReader(tokio::task::AbortHandle);
impl Drop for AbortHttpReader {fn drop(&mut self){self.0.abort();}}
#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnswerBackend { #[default] Chatgpt, Codex, Api, Websocket, Realtime }
impl AnswerBackend {
    pub fn is_api(self) -> bool { matches!(self, Self::Api | Self::Websocket | Self::Realtime) }
}
impl Default for Client {
    fn default() -> Self {
        Self {
            responses_ws: Default::default(),
            trace: None,
            refill_policy: super::codex::RefillPolicy::default(),
            http_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(120))
                .pool_idle_timeout(None)
                .tcp_keepalive(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
            base: {
                #[cfg(all(feature = "acceptance", debug_assertions))]
                if super::http_fixture_mode() {
                    let base =
                        std::env::var("COPILOT_TEST_API").expect("Local test server required");
                    let u = url::Url::parse(&base).expect("Test API URL");
                    assert!(u.scheme() == "http" && u.host_str() == Some("127.0.0.1"));
                    return Self {
                        responses_ws: Default::default(),
                        trace: None,
                        refill_policy: super::codex::RefillPolicy::default(),
                        http_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
                        http: reqwest::Client::new(),
                        base,
                        reasoning_effort: None,
                        backend: AnswerBackend::Chatgpt,
                        service_tier: None,
                        reply_schema: None,
                        codex: None,
                    };
                }
                "https://api.openai.com/v1".into()
            },
            reasoning_effort: None,
            backend: AnswerBackend::Chatgpt,
            service_tier: None,
            reply_schema: None,
            codex: None,
        }
    }
}
#[derive(Debug)]
pub enum StreamEvent {
    Delta(String),
    Revision(String),
    QuestionDelta { question: String, context_key:[u8;32], text: String },
    NoReply { question: String, context_key:[u8;32] },
    QuestionCompleted { question:String, context_key:[u8;32] },
    Completed,
}
/// Input identity is immutable; a provider may still emit multiple messages.
/// Keep delivered text lossless across their boundaries and parse each frame.
struct AcceptedReplyDecoder {
    gate: super::codex::ReplyGate,
    question: String,
    context_key: [u8;32],
    explicit: bool,
    answered: bool,
}
impl AcceptedReplyDecoder {
    fn new(prompt:&super::codex::QuestionPrompt)->Self {
        Self {gate:Default::default(),question:prompt.question.clone(),context_key:super::codex::context_key(&prompt.context),explicit:prompt.explicit_request,answered:false}
    }
    fn delta(&self,text:String)->StreamEvent {
        StreamEvent::QuestionDelta{question:self.question.clone(),context_key:self.context_key,text}
    }
    fn finish_message(&mut self)->Result<(),String> {
        self.gate.finish()?;
        if self.gate.ignored&&self.explicit{return Err("The backend ignored an explicitly accepted request".into());}
        Ok(())
    }
    fn decode(&mut self,raw:StreamEvent)->Result<Option<StreamEvent>,String> {
        match raw {
            StreamEvent::Delta(text)=>{
                let text=self.gate.feed(&text)?;
                if let Some(text)=text {self.answered=true;Ok(Some(self.delta(text)))}else{Ok(None)}
            },
            StreamEvent::Revision(text) if text.is_empty()=>{
                // Codex emits this boundary when another non-commentary
                // agent message begins, even with no changed user input.
                // Do not clear the renderer or concatenate raw JSON frames.
                self.finish_message()?;
                self.gate=Default::default();
                Ok(self.answered.then(||self.delta("\n\n".into())))
            },
            StreamEvent::Completed=>{
                self.finish_message()?;
                Ok(Some(if self.gate.ignored&&!self.answered {
                    StreamEvent::NoReply{question:self.question.clone(),context_key:self.context_key}
                }else{
                    StreamEvent::QuestionCompleted{question:self.question.clone(),context_key:self.context_key}
                }))
            },
            _=>Err("Unexpected event for an immutable conversation generation".into()),
        }
    }
}
pub fn request_body(model: &str, instructions: &str, input: &str) -> serde_json::Value {
    serde_json::json!({"model":model,"store":false,"stream":true,"instructions":instructions,"input":[{"role":"user","content":input}]})
}
pub fn request_body_with_image(model: &str, instructions: &str, input: &str, image: Option<&str>) -> serde_json::Value {
    let mut body = request_body(model, instructions, input);
    if let Some(image) = image {
        body["input"][0]["content"] = serde_json::json!([
            {"type":"input_text", "text":input},
            {"type":"input_image", "image_url":image, "detail":"auto"}
        ]);
    }
    body
}
impl Client {
    pub fn with_trace(mut self, trace: super::timing::Trace) -> Self { self.trace=Some(trace);self }
    pub fn with_refill(mut self, policy: super::codex::RefillPolicy) -> Self { self.refill_policy=policy;self }
    pub fn with_backend(mut self, backend: AnswerBackend, tier: Option<&str>) -> Self {
        self.backend = backend;
        self.service_tier = tier.map(String::from);
        self
    }
    pub fn requires_token(&self) -> bool { self.backend == AnswerBackend::Chatgpt }
    pub fn backend(&self) -> AnswerBackend { self.backend }
    pub fn with_reasoning(mut self, effort: Option<&str>) -> Self {
        self.reasoning_effort = effort.map(String::from);
        self
    }
    pub(super) fn body(&self, model: &str, instructions: &str, input: &str, image: Option<&str>) -> serde_json::Value {
        let mut body = request_body_with_image(model, instructions, input, image);
        if let Some(effort) = &self.reasoning_effort {
            body["reasoning"] = serde_json::json!({"effort": effort});
        }
        if let Some(tier) = &self.service_tier {
            body["service_tier"] = serde_json::json!(tier);
        }
        if let Some(schema) = &self.reply_schema {
            body["text"] = serde_json::json!({"format":{"type":"json_schema","name":"meeting_reply","strict":true,"schema":schema}});
        }
        body
    }
    pub async fn models(&self, token: &str) -> Result<Vec<Model>, String> {
        if self.backend == AnswerBackend::Codex {
            return self.codex.as_ref().ok_or("Codex runtime is unavailable")?.models().await;
        }
        let r = self
            .http
            .get(format!("{}/models", self.base))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "Model discovery connection failed".to_string())?;
        let r = check_http(r).await?;
        let value: serde_json::Value = r.json().await.map_err(|_| "Invalid model catalog".to_string())?;
        if self.backend.is_api() {
            let models = value["data"].as_array().ok_or("API returned no model catalog")?
                .iter().filter_map(|row| row["id"].as_str())
                .filter(|id| if self.backend == AnswerBackend::Realtime { id.starts_with("gpt-realtime") } else { id.starts_with("gpt-") && !id.contains("realtime") && !id.contains("audio") && !id.contains("transcribe") && !id.contains("image") })
                .map(|id| Model { slug:id.into(),display_name:id.into() }).collect::<Vec<_>>();
            if models.is_empty() { return Err("No answer models are available for this API key".into()); }
            Ok(models)
        } else { parse_models(value) }
    }
    pub async fn stream<F, Fut>(
        &self,
        token: &str,
        model: &str,
        instructions: &str,
        input: &str,
        cancel: CancellationToken,
        event: F,
    ) -> Result<(), String>
    where
        F: FnMut(StreamEvent) -> Fut + Send,
        Fut: std::future::Future<Output = Result<(), String>> + Send,
    {
        self.stream_with_image(token, model, instructions, input, None, cancel, event).await
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn stream_with_image<F, Fut>(
        &self, token: &str, model: &str, instructions: &str, input: &str,
        image: Option<&str>, cancel: CancellationToken, event: F,
    ) -> Result<(), String>
    where
        F: FnMut(StreamEvent) -> Fut + Send,
        Fut: std::future::Future<Output = Result<(), String>> + Send,
    {
        if self.backend == AnswerBackend::Realtime {
            return super::realtime::stream(token,model,instructions,input,cancel,event).await;
        }
        if self.backend == AnswerBackend::Websocket {
            return self.responses_ws.stream(self.body(model,instructions,input,image), token, cancel, None, self.trace.clone(), event).await;
        }
        if self.backend == AnswerBackend::Codex {
            return self.codex.as_ref().ok_or("Codex runtime is unavailable")?
                .stream_traced(model, self.service_tier.as_deref(), self.reasoning_effort.as_deref(), instructions, input, image, cancel, self.refill_policy, self.trace.clone(), event).await;
        }
        let permit=tokio::select!{
            biased;
            _=cancel.cancelled()=>return Err("cancelled".into()),
            acquired=tokio::time::timeout(std::time::Duration::from_millis(2500),self.http_slots.clone().acquire_owned())=>
                acquired.map_err(|_|"Answer capacity recovery deadline exceeded; ask again")?.map_err(|_|"Answer capacity is unavailable")?
        };
        if cancel.is_cancelled(){return Err("cancelled".into());}
        if let Some(trace)=&self.trace{trace.mark(super::timing::Stage::SemaphoreAcquired);}
        let mut terminal=false;
        let result=self.stream_http(token,model,instructions,input,image,cancel,&mut terminal,event).await;
        if result.is_err()&&!terminal{
            // Closing an HTTP stream does not prove provider termination. A
            // bounded hold prevents cancellation/error storms while allowing
            // one new foreground stream. It is not a remote cancellation ack.
            self.hold_http_retirement(permit);
        }
        result
    }
    fn hold_http_retirement(&self,permit:tokio::sync::OwnedSemaphorePermit){
        let trace=self.trace.clone();if let Some(trace)=&trace{trace.local_retirement_started();}
        tokio::spawn(async move{
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            if let Some(trace)=trace{trace.local_retirement_released();}
            drop(permit);
        });
    }
    #[allow(clippy::too_many_arguments)]
    async fn stream_http<F,Fut>(&self,token:&str,model:&str,instructions:&str,input:&str,image:Option<&str>,cancel:CancellationToken,terminal:&mut bool,mut event:F)->Result<(),String>
    where F:FnMut(StreamEvent)->Fut+Send,Fut:std::future::Future<Output=Result<(),String>>+Send {
        if let Some(trace)=&self.trace { trace.backend("http"); trace.mark(super::timing::Stage::StreamEntered); trace.request_sent(); }
        let request = self
            .http
            .post(format!("{}/responses", self.base))
            .bearer_auth(token)
            .json(&self.body(model, instructions, input, image))
            .send();
        let response = tokio::select! {_=cancel.cancelled()=>return Err("cancelled".into()),r=request=>r.map_err(|_|"Answer request connection failed".to_string())?};
        let response = tokio::select! {_=cancel.cancelled()=>return Err("cancelled".into()),r=check_http(response)=>r?};
        let mut chunks = response.bytes_stream();
        let (delivery,mut queued)=super::mailbox::channel(256);
        let remote_terminal=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed_terminal=remote_terminal.clone();let reader_cancel=cancel.clone();let trace=self.trace.clone();
        let mut reading=tokio::spawn(async move {
         let mut parser = SseParser::default();
         loop {
            let next = tokio::select! {_=reader_cancel.cancelled()=>return Err("cancelled".into()),c=chunks.next()=>c};
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|_| "Answer stream was interrupted".to_string())?;
            for data in parser.push(&chunk)? {
                if data == "[DONE]" {
                    continue;
                }
                let value: serde_json::Value = serde_json::from_str(&data)
                    .map_err(|_| "Invalid answer stream event".to_string())?;
                match value["type"].as_str().unwrap_or("") {
                    "response.created" => { if let Some(trace)=&trace { trace.created(); } }
                    "response.output_text.delta" => {
                        if let Some(trace)=&trace { trace.mark(super::timing::Stage::FirstAgentDelta); }
                        if value["delta"].is_string(){delivery.try_send(value)?;}
                    }
                    "response.completed" => {
                        observed_terminal.store(true,std::sync::atomic::Ordering::Release);
                        if let Some(trace)=&trace { trace.response_metadata(&value["response"]);trace.usage(&value["response"]["usage"]); trace.mark(super::timing::Stage::TurnCompleted); }
                        delivery.try_send(value)?;
                        return Ok::<(),String>(());
                    }
                    "error" | "response.failed" | "response.incomplete" => {
                        observed_terminal.store(true,std::sync::atomic::Ordering::Release);
                        if let Some(trace)=&trace{trace.remote_terminal();}
                        return Err(stream_error(&value))
                    }
                    _ => {}
                }
            }
         }
         Err("Answer stream ended before response.completed".into())
        });
        let _reader_guard=AbortHttpReader(reading.abort_handle());
        let consuming=async {
         loop {
            let value=tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),value=queued.recv()=>value.ok_or("Answer delivery closed before completion")?};
            let output=match value["type"].as_str(){
                Some("response.output_text.delta")=>StreamEvent::Delta(value["delta"].as_str().ok_or("Missing answer text delta")?.into()),
                Some("response.completed")=>StreamEvent::Completed,
                _=>return Err("Answer accumulation exceeds 4 MiB; current generation failed explicitly".into()),
            };
            let completed=matches!(&output,StreamEvent::Completed);
            tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),result=event(output)=>result?};
            if completed{return Ok::<(),String>(());}
         }
        };
        // A separately scheduled owned reader keeps protocol progress apart
        // from callback delivery. Dropping the request aborts that reader.
        // Successful completion still drains every current delta in order.
        tokio::pin!(consuming);
        let result=tokio::select!{
            result=&mut reading=>match result {
                Ok(Ok(()))=>consuming.await,
                Ok(Err(error))=>Err(error),
                Err(_)=>Err("Answer protocol reader failed".into()),
            },
            result=&mut consuming=>result,
        };
        *terminal=remote_terminal.load(std::sync::atomic::Ordering::Acquire);
        result
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn stream_updates<F,Fut>(&self, token:&str, model:&str, instructions:&str, input:&str, image:Option<&str>, cancel:CancellationToken, updates:tokio::sync::watch::Receiver<super::responses_ws::Update>, event:F) -> Result<(),String>
    where F:FnMut(StreamEvent)->Fut+Send, Fut:std::future::Future<Output=Result<(),String>>+Send {
        if self.backend == AnswerBackend::Websocket {
            self.responses_ws.stream(self.body(model,instructions,input,image),token,cancel,Some(updates),self.trace.clone(),event).await
        } else { self.stream_with_image(token,model,instructions,input,image,cancel,event).await }
    }
    pub async fn prewarm(&self, token:&str, model:&str, instructions:&str, context:&str, cancel:&CancellationToken) -> Result<(),String> {
        self.responses_ws.prewarm(self.body(model,instructions,context,None),token,cancel).await
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn stream_question<F, Fut>(&self, token: &str, model: &str, instructions: &str, prompt: &super::codex::QuestionPrompt,
        image: Option<&str>, cancel: CancellationToken, updates: tokio::sync::watch::Receiver<super::codex::QuestionUpdate>, mut event: F) -> Result<(), String>
    where F: FnMut(StreamEvent) -> Fut + Send, Fut: std::future::Future<Output=Result<(), String>> + Send {
        let frame=updates.borrow().clone();
        if !frame.confirmed || frame.question!=prompt.question || frame.context.as_deref()!=Some(&prompt.context) {return Err("Only an immutable accepted conversation frame may be submitted".into());}
        let mut decoder=AcceptedReplyDecoder::new(prompt);
        let mut decode=|raw|{
            let decoded=decoder.decode(raw);
            // Return a single concrete future type, including no-text prefixes.
            let (error,future)=match decoded {Ok(Some(value))=>(None,Some(event(value))),Ok(None)=>(None,None),Err(e)=>(Some(e),None)};
            async move {if let Some(e)=error{Err(e)}else if let Some(future)=future{future.await}else{Ok(())}}
        };
        if self.backend == AnswerBackend::Codex {
            self.codex.as_ref().ok_or("Codex runtime is unavailable")?.stream_question(model,self.service_tier.as_deref(),self.reasoning_effort.as_deref(),instructions,prompt,image,cancel,self.refill_policy,self.trace.clone(),updates,&mut decode).await
        } else {
            let mut request=self.clone();
            if matches!(self.backend,AnswerBackend::Chatgpt|AnswerBackend::Api) {
                let mut schema=super::codex::automatic_reply_schema();
                if prompt.explicit_request {schema["properties"]["intent"]["enum"]=serde_json::json!(["answer"]);}
                request.reply_schema=Some(schema);
            }
            let result=request.stream_with_image(token,model,instructions,&format!("AUTOMATIC REMOTE TURN\n{}",prompt.render()),image,cancel.clone(),&mut decode).await;
            if cancel.is_cancelled(){if let Some(trace)=&self.trace{trace.cancelled();}}
            result
        }
    }
    pub async fn text(
        &self,
        token: &str,
        model: &str,
        instructions: &str,
        input: &str,
        cancel: CancellationToken,
    ) -> Result<String, String> {
        let mut result = String::new();
        self.stream(token, model, instructions, input, cancel, |event| {
            if let StreamEvent::Revision(text) = &event {
                if text.len()>65_536{return std::future::ready(Err("Meeting memory response exceeds size limit".into()));}
                result=text.clone();
            }
            if let StreamEvent::Delta(d) = event {
                if result.len() + d.len() > 65_536 {
                    return std::future::ready(Err(
                        "Meeting memory response exceeds size limit".into()
                    ));
                }
                result.push_str(&d)
            }
            std::future::ready(Ok(()))
        })
        .await?;
        Ok(result)
    }
}
async fn check_http(r: reqwest::Response) -> Result<reqwest::Response, String> {
    if r.status().is_success() {
        Ok(r)
    } else {
        let status = r.status();
        let id = r
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();
        let v: serde_json::Value = r.json().await.unwrap_or_default();
        let code = v["error"]["code"].as_str().unwrap_or("unknown");
        let advice = match status.as_u16() {
            401 => "Sign in again",
            403 => "ChatGPT plan permission or serving region is unavailable",
            429 => "Plan usage limit reached; try later",
            _ => "OpenAI request failed",
        };
        Err(format!(
            "{advice} (HTTP {status}, code {code}, request {id})"
        ))
    }
}
fn stream_error(v: &serde_json::Value) -> String {
    let code = v["response"]["error"]["code"]
        .as_str()
        .or(v["error"]["code"].as_str())
        .or(v["code"].as_str())
        .unwrap_or("incomplete_or_failed");
    format!("OpenAI response did not complete ({code})")
}
#[derive(Default)]
pub struct SseParser {
    bytes: Vec<u8>,
}
impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > 1_048_576 {
            return Err("Answer stream event exceeds size limit".into());
        }
        let mut result = vec![];
        loop {
            let lf = self
                .bytes
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|i| (i, 2));
            let crlf = self
                .bytes
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|i| (i, 4));
            let delim = match (lf, crlf) {
                (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
                (a, None) => a,
                (None, b) => b,
            };
            let Some((i, n)) = delim else { break };
            let data: Vec<_> = self.bytes.drain(..i + n).collect();
            let s =
                std::str::from_utf8(&data).map_err(|_| "Answer stream contains invalid UTF-8")?;
            let joined = s
                .lines()
                .filter_map(|l| {
                    l.strip_prefix("data:")
                        .map(|d| d.strip_prefix(' ').unwrap_or(d))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !joined.is_empty() {
                result.push(joined)
            }
        }
        Ok(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    fn automatic_message(intent:&str,text:&str)->StreamEvent {
        StreamEvent::Delta(serde_json::json!({"intent":intent,"text":text}).to_string())
    }
    #[test]
    fn multiple_provider_messages_keep_exact_text_on_one_accepted_generation() {
        let prompt=super::super::codex::QuestionPrompt::new("Exact source","Follow up");
        let mut decoder=AcceptedReplyDecoder::new(&prompt);
        let first="First source α.\n```cpp\nint X=-17;\n```";
        let second="Second message: retain the original source.";
        let mut text=String::new();
        for raw in [automatic_message("answer",first),StreamEvent::Revision(String::new()),automatic_message("answer",second)] {
            match decoder.decode(raw).unwrap().unwrap() {
                StreamEvent::QuestionDelta{question,context_key,text:delta}=>{
                    assert_eq!(question,prompt.question);assert_eq!(context_key,super::super::codex::context_key(&prompt.context));text.push_str(&delta);
                },_=>panic!("Output boundary must not reset the generation or discard text"),
            }
        }
        assert_eq!(text,format!("{first}\n\n{second}"));
        assert!(matches!(decoder.decode(StreamEvent::Completed).unwrap(),Some(StreamEvent::QuestionCompleted{..})));
    }
    #[test]
    fn later_automatic_ignore_cannot_erase_a_delivered_answer() {
        let mut decoder=AcceptedReplyDecoder::new(&super::super::codex::QuestionPrompt::new("Source","Question"));
        assert!(decoder.decode(automatic_message("answer","Keep this exact answer.")).unwrap().is_some());
        decoder.decode(StreamEvent::Revision(String::new())).unwrap();
        assert!(decoder.decode(automatic_message("ignore","")).unwrap().is_none());
        assert!(matches!(decoder.decode(StreamEvent::Completed).unwrap(),Some(StreamEvent::QuestionCompleted{..})));
    }
    #[test]
    fn ignored_first_message_does_not_create_displayed_text_before_an_answer() {
        let mut decoder=AcceptedReplyDecoder::new(&super::super::codex::QuestionPrompt::new("Source","Question"));
        assert!(decoder.decode(automatic_message("ignore","")).unwrap().is_none());
        assert!(decoder.decode(StreamEvent::Revision(String::new())).unwrap().is_none());
        match decoder.decode(automatic_message("answer","Actual response.")).unwrap().unwrap(){StreamEvent::QuestionDelta{text,..}=>assert_eq!(text,"Actual response."),_=>panic!()}
        assert!(matches!(decoder.decode(StreamEvent::Completed).unwrap(),Some(StreamEvent::QuestionCompleted{..})));
    }
    #[test]
    fn message_boundary_rejects_missing_framing_instead_of_discarding_it() {
        let mut decoder=AcceptedReplyDecoder::new(&super::super::codex::QuestionPrompt::new("Source","Question"));
        decoder.decode(StreamEvent::Delta("{\"intent\":\"answer\",\"text\":\"Partial".into())).unwrap();
        let error=decoder.decode(StreamEvent::Revision(String::new())).unwrap_err();
        assert!(error.contains("JSON is invalid"));
    }
    #[test]
    fn explicit_ignore_and_unexpected_identity_changes_still_fail_visibly() {
        let mut decoder=AcceptedReplyDecoder::new(&super::super::codex::QuestionPrompt::new("Source","Question").with_explicit_request(true));
        decoder.decode(automatic_message("ignore","")).unwrap();
        assert!(decoder.decode(StreamEvent::Revision(String::new())).unwrap_err().contains("explicitly accepted"));
        assert!(decoder.decode(StreamEvent::Revision("changed input".into())).is_err());
    }
    async fn server(
        body: &str,
        delay: u64,
    ) -> (Client, tokio::task::JoinHandle<serde_json::Value>) {
        server_phased(body,delay,None).await
    }
    async fn server_phased(body:&str,delay:u64,mut gate:Option<(usize,std::sync::Arc<tokio::sync::Notify>)>) -> (Client,tokio::task::JoinHandle<serde_json::Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let body = body.to_string();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![];
            let parsed = loop {
                let mut bytes = [0u8; 1024];
                let n = socket.read(&mut bytes).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&bytes[..n]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&request[..end]);
                    let length: usize = header
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        assert!(header
                            .to_lowercase()
                            .contains("authorization: bearer fixture-token"));
                        break serde_json::from_slice(&request[end + 4..end + 4 + length]).unwrap();
                    }
                }
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
            let chunk_size=if body.len()>512*1024{64*1024}else{7};
            for (index,chunk) in body.as_bytes().chunks(chunk_size).enumerate() {
                if gate.as_ref().is_some_and(|(offset,_)|index*chunk_size>=*offset){gate.take().unwrap().1.notified().await;}
                if socket.write_all(chunk).await.is_err() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            parsed
        });
        (
            Client {
                responses_ws: Default::default(),
                trace: None,
                refill_policy: super::super::codex::RefillPolicy::default(),
                http_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
                http: reqwest::Client::new(),
                base,
                reasoning_effort: None,
                backend: AnswerBackend::Chatgpt,
                service_tier: None,
                reply_schema: None,
                codex: None,
            },
            task,
        )
    }
    #[tokio::test]
    async fn plan_adapter_uses_the_same_immutable_generation_protocol() {
        let raw=serde_json::json!({"intent":"answer","text":"Because Foo < -1 is the exact guard.\n```cpp\nreturn x < -1;\n```"}).to_string();
        let body=format!("data: {}\n\ndata: {{\"type\":\"response.completed\"}}\n\n",serde_json::json!({"type":"response.output_text.delta","delta":raw}));
        let (client,server)=server(&body,0).await;
        let prompt=super::super::codex::QuestionPrompt::new("Exact preceding code", "Why?");
        let (_,rx)=tokio::sync::watch::channel(super::super::codex::QuestionUpdate{question:prompt.question.clone(),context:Some(prompt.context.clone()),confirmed:true,acoustic_quiet:true});
        let mut text=String::new();let mut completed=false;
        client.stream_question("fixture-token","gpt-6.1-sol",&super::super::prompts::answer_instructions(super::super::prompts::ANSWER),&prompt,None,CancellationToken::new(),rx,|event| {
            match event {StreamEvent::QuestionDelta{question,context_key,text:delta}=>{assert_eq!(question,"Why?");assert_eq!(context_key,super::super::codex::context_key("Exact preceding code"));text.push_str(&delta);},StreamEvent::QuestionCompleted{..}=>completed=true,_=>panic!("Unexpected event")};std::future::ready(Ok(()))
        }).await.unwrap();
        assert!(completed&&text.contains("return x < -1;"));let sent=server.await.unwrap();
        assert_eq!(sent["text"]["format"],serde_json::json!({"type":"json_schema","name":"meeting_reply","strict":true,"schema":super::super::codex::automatic_reply_schema()}));
        assert!(client.body("m","i","q",None).get("text").is_none(),"The request clone must not contaminate summaries");
        assert_eq!(sent["store"],false);assert_eq!(sent["stream"],true);assert_eq!(sent["input"].as_array().unwrap().len(),1);
        for unsupported in ["previous_response_id","conversation","background","max_output_tokens","prompt_cache_retention"]{assert!(sent.get(unsupported).is_none());}
    }
    #[tokio::test]
    async fn plan_adapter_rejects_silent_ignore_for_an_explicit_request() {
        let raw=serde_json::json!({"intent":"ignore","text":""}).to_string();
        let body=format!("data: {}\n\ndata: {{\"type\":\"response.completed\"}}\n\n",serde_json::json!({"type":"response.output_text.delta","delta":raw}));
        let (client,server)=server(&body,0).await;
        let prompt=super::super::codex::QuestionPrompt::new("Exact preceding source","Please answer").with_explicit_request(true);
        let (_,rx)=tokio::sync::watch::channel(super::super::codex::QuestionUpdate{question:prompt.question.clone(),context:Some(prompt.context.clone()),confirmed:true,acoustic_quiet:true});
        let instructions=super::super::prompts::answer_instructions(super::super::prompts::ANSWER);
        let mut delivered=false;
        let error=client.stream_question("fixture-token","gpt-6.1-sol",&instructions,&prompt,None,CancellationToken::new(),rx,|_|{delivered=true;std::future::ready(Ok(()))}).await.unwrap_err();
        assert!(error.contains("explicitly accepted"));assert!(!delivered);
        assert_eq!(client.http_slots.available_permits(),2);
        let sent=server.await.unwrap();assert_eq!(sent["instructions"],instructions);
        assert_eq!(sent["text"]["format"]["schema"]["properties"]["intent"]["enum"],serde_json::json!(["answer"]));
        assert!(sent["input"][0]["content"].as_str().unwrap().starts_with("AUTOMATIC REMOTE TURN\nAPPLICATION ACCEPTANCE: EXPLICIT\n"));
    }
    #[tokio::test]
    async fn plan_reasoning_trial_framing_failure_remains_visible() {
        // The authenticated trial exposed an invalid envelope, not captured raw
        // provider bytes. These variants exercise the generic decoder contract.
        for raw in ["An unframed explanation.","```json\n{\"intent\":\"answer\",\"text\":\"Explanation\"}\n```",""] {
            let body=format!("data: {}\n\ndata: {{\"type\":\"response.completed\"}}\n\n",serde_json::json!({"type":"response.output_text.delta","delta":raw}));
            let (client,server)=server(&body,0).await;
            let prompt=super::super::codex::QuestionPrompt::new("Retained conversation","Explain the invariant");
            let (_,rx)=tokio::sync::watch::channel(super::super::codex::QuestionUpdate{question:prompt.question.clone(),context:Some(prompt.context.clone()),confirmed:true,acoustic_quiet:true});
            let mut completed=false;
            assert!(client.stream_question("fixture-token","gpt-6.1-sol","instructions",&prompt,None,CancellationToken::new(),rx,|event|{completed|=matches!(event,StreamEvent::QuestionCompleted{..});std::future::ready(Ok(()))}).await.is_err());
            assert!(!completed);
            assert_eq!(server.await.unwrap()["text"]["format"]["strict"],true);
        }
    }
    #[tokio::test]
    async fn real_http_stream_contract() {
        let (c,server)=server("data: {\"type\":\"response.output_text.delta\",\"delta\":\"October \"}\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"28 🎉\"}\r\n\r\ndata: {\"type\":\"response.completed\"}\r\n\r\n",1).await;
        let text = c
            .text(
                "fixture-token",
                "account-model",
                "instructions",
                "REMOTE: fixture context",
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(text, "October 28 🎉");
        let b = server.await.unwrap();
        assert_eq!(
            b,
            request_body("account-model", "instructions", "REMOTE: fixture context")
        );
    }
    #[tokio::test]
    async fn requested_service_tier_reaches_http_request() {
        for tier in ["fast", "priority"] {
            let (client, server) = server("data: {\"type\":\"response.completed\"}\n\n", 0).await;
            client
                .with_backend(AnswerBackend::Chatgpt, Some(tier))
                .text("fixture-token", "account-model", "instructions", "fixture", CancellationToken::new())
                .await
                .unwrap();
            let body = server.await.unwrap();
            assert_eq!(body["service_tier"], tier);
            assert_eq!(body["store"], false);
            assert_eq!(body["stream"], true);
        }
        assert!(Client::default().body("m", "i", "q", None).get("service_tier").is_none());
    }
    #[tokio::test]
    async fn requested_reasoning_effort_reaches_http_request() {
        let (client, server) = server("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Fixture\"}\n\ndata: {\"type\":\"response.completed\"}\n\n", 0).await;
        client
            .with_reasoning(Some("xhigh"))
            .text(
                "fixture-token",
                "account-model",
                "instructions",
                "fixture",
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let body = server.await.unwrap();
        assert_eq!(body["reasoning"]["effort"], "xhigh");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert!(request_body("m", "i", "q").get("reasoning").is_none());
    }
    #[tokio::test]
    async fn image_input_reaches_http_without_file_upload_or_response_storage() {
        let (client, server) = server("data: {\"type\":\"response.completed\"}\n\n", 0).await;
        let image = "data:image/png;base64,c3ludGhldGlj";
        client.with_reasoning(Some("low")).stream_with_image("fixture-token", "account-model", "instructions", "screen question", Some(image), CancellationToken::new(), |_| std::future::ready(Ok(()))).await.unwrap();
        let body = server.await.unwrap();
        assert_eq!(body["input"][0]["content"][0]["text"], "screen question");
        assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(body["input"][0]["content"][1]["image_url"], image);
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["store"], false); assert_eq!(body["stream"], true);
    }
    #[tokio::test]
    async fn incomplete_or_failed_stream_never_reports_success() {
        for body in ["data: {\"type\":\"response.output_text.delta\",\"delta\":\"Partial\"}\n\n","data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n"]{let (c,s)=server(body,0).await;assert!(c.text("fixture-token","m","i","q",CancellationToken::new()).await.is_err());s.await.unwrap();}
    }
    #[tokio::test]
    async fn cancellation_closes_live_request() {
        let (c,s)=server("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Some very slow answer\"}\n\ndata: {\"type\":\"response.completed\"}\n\n",30).await;
        let cancel = CancellationToken::new();
        let abort = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            abort.cancel();
        });
        let start = std::time::Instant::now();
        assert_eq!(
            c.text("fixture-token", "m", "i", "q", cancel)
                .await
                .unwrap_err(),
            "cancelled"
        );
        assert!(start.elapsed().as_millis() < 500);
        assert_eq!(c.http_slots.available_permits(),1,"Closed local stream must still count its unknown retirement");
        s.await.unwrap();
    }
    #[tokio::test]
    async fn http_terminal_is_observed_while_output_is_stalled_and_every_delta_is_drained() {
        let expected=(0..24).map(|i|format!("piece-{i}| ")).collect::<Vec<_>>();
        let mut body=expected.iter().map(|text|format!("data: {}\n\n",serde_json::json!({"type":"response.output_text.delta","delta":text}))).collect::<String>();
        body.push_str("data: {\"type\":\"response.completed\"}\n\n");
        let (client,server)=server(&body,0).await;
        let trace=super::super::timing::Trace::new(std::time::Instant::now(),0);
        let client=client.with_trace(trace.clone());let observer=client.clone();
        let entered=std::sync::Arc::new(tokio::sync::Notify::new());let release=std::sync::Arc::new(tokio::sync::Notify::new());
        let output=std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (seen,gate,result)=(entered.clone(),release.clone(),output.clone());
        let job=tokio::spawn(async move{client.stream("fixture-token","m","i","q",CancellationToken::new(),move |event|{
            let (seen,gate,result)=(seen.clone(),gate.clone(),result.clone());
            async move {
                if let StreamEvent::Delta(text)=event {
                    let first={let mut result=result.lock().unwrap();let first=result.is_empty();result.push(text);first};
                    if first{seen.notify_one();gate.notified().await;}
                }
                Ok(())
            }
        }).await});
        tokio::time::timeout(std::time::Duration::from_secs(3),entered.notified()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3),async{while trace.snapshot().turn_completed.is_none(){tokio::time::sleep(std::time::Duration::from_millis(5)).await;}}).await.unwrap();
        assert!(!job.is_finished(),"Protocol completion cannot silently discard pending output");
        assert_eq!(trace.snapshot().remote_termination_confirmed,Some(true));
        release.notify_one();assert!(tokio::time::timeout(std::time::Duration::from_secs(3),job).await.unwrap().unwrap().is_ok());
        assert_eq!(*output.lock().unwrap(),expected);assert_eq!(observer.http_slots.available_permits(),2);server.await.unwrap();
    }
    #[tokio::test]
    async fn http_cancellation_bypasses_stalled_output_after_known_remote_completion() {
        let (client,server)=server("data: {\"type\":\"response.output_text.delta\",\"delta\":\"opening\"}\n\ndata: {\"type\":\"response.completed\"}\n\n",0).await;
        let trace=super::super::timing::Trace::new(std::time::Instant::now(),0);
        let client=client.with_trace(trace.clone());let observer=client.clone();let cancel=CancellationToken::new();let stop=cancel.clone();
        let entered=std::sync::Arc::new(tokio::sync::Notify::new());let seen=entered.clone();
        let job=tokio::spawn(async move{client.stream("fixture-token","m","i","q",cancel,move |event|{
            let seen=seen.clone();async move{if matches!(event,StreamEvent::Delta(_)){seen.notify_one();std::future::pending::<()>().await;}Ok(())}
        }).await});
        tokio::time::timeout(std::time::Duration::from_secs(3),entered.notified()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3),async{while trace.snapshot().turn_completed.is_none(){tokio::time::sleep(std::time::Duration::from_millis(5)).await;}}).await.unwrap();
        stop.cancel();assert_eq!(tokio::time::timeout(std::time::Duration::from_millis(250),job).await.unwrap().unwrap().unwrap_err(),"cancelled");
        assert_eq!(observer.http_slots.available_permits(),2,"Known terminal does not need an unknown-retirement hold");
        assert_eq!(trace.snapshot().remote_termination_confirmed,Some(true));server.await.unwrap();
    }
    #[tokio::test]
    async fn http_failure_bypasses_an_already_stalled_output_consumer() {
        let prefix="data: {\"type\":\"response.output_text.delta\",\"delta\":\"opening\"}\n\n";
        let body=format!("{prefix}data: {{\"type\":\"response.failed\",\"response\":{{\"error\":{{\"code\":\"fixture_failure\"}}}}}}\n\n");
        let release=std::sync::Arc::new(tokio::sync::Notify::new());
        let (client,server)=server_phased(&body,0,Some((prefix.len(),release.clone()))).await;
        let trace=super::super::timing::Trace::new(std::time::Instant::now(),0);let client=client.with_trace(trace.clone());let observer=client.clone();
        let entered=std::sync::Arc::new(tokio::sync::Notify::new());let seen=entered.clone();
        let job=tokio::spawn(async move{client.stream("fixture-token","m","i","q",CancellationToken::new(),move |event|{
            let seen=seen.clone();async move{if matches!(event,StreamEvent::Delta(_)){seen.notify_one();std::future::pending::<()>().await;}Ok(())}
        }).await});
        tokio::time::timeout(std::time::Duration::from_secs(3),entered.notified()).await.unwrap();release.notify_one();
        assert!(tokio::time::timeout(std::time::Duration::from_secs(3),job).await.unwrap().unwrap().is_err());
        assert_eq!(trace.snapshot().remote_termination_confirmed,Some(true));assert_eq!(observer.http_slots.available_permits(),2);server.await.unwrap();
    }
    #[tokio::test]
    async fn http_accumulation_overflow_fails_explicitly_instead_of_dropping_current_text() {
        let piece=format!("data: {}\n\n",serde_json::json!({"type":"response.output_text.delta","delta":"x".repeat(900_000)}));
        let body=piece.repeat(6)+"data: {\"type\":\"response.completed\"}\n\n";
        let (client,server)=server(&body,0).await;
        let result=tokio::time::timeout(std::time::Duration::from_secs(3),client.stream("fixture-token","m","i","q",CancellationToken::new(),|_|std::future::pending::<Result<(),String>>())).await.unwrap();
        assert!(result.unwrap_err().contains("4 MiB"));
        assert_eq!(client.http_slots.available_permits(),1,"Overflow before a provider terminal remains an unknown retirement");server.await.unwrap();
    }
    #[tokio::test(start_paused=true)]
    async fn unknown_http_retirement_holds_capacity_without_claiming_remote_termination(){
        let trace=super::super::timing::Trace::new(std::time::Instant::now(),0);
        let c=Client::default().with_trace(trace.clone());
        let old=c.http_slots.clone().acquire_owned().await.unwrap();
        c.hold_http_retirement(old);
        let current=c.http_slots.clone().acquire_owned().await.unwrap();
        assert_eq!(c.clone().http_slots.available_permits(),0);
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_millis(1499)).await;
        assert_eq!(c.http_slots.available_permits(),0);
        assert_eq!(trace.snapshot().remote_termination_confirmed,Some(false));
        tokio::time::advance(std::time::Duration::from_millis(1)).await;tokio::task::yield_now().await;
        assert_eq!(c.http_slots.available_permits(),1);
        assert!(trace.snapshot().local_retirement_released_at.is_some());
        assert_eq!(trace.snapshot().remote_termination_confirmed,Some(false));
        drop(current);
    }
    #[tokio::test(start_paused=true)]
    async fn unavailable_http_capacity_fails_before_submitting_and_next_request_remains_eligible(){
        let trace=super::super::timing::Trace::new(std::time::Instant::now(),0);
        let c=Client::default().with_trace(trace.clone());
        let slots=c.http_slots.clone().acquire_many_owned(2).await.unwrap();
        let start=tokio::time::Instant::now();
        let result=c.text("fixture-token","m","i","q",CancellationToken::new()).await;
        assert!(result.unwrap_err().contains("capacity recovery deadline"));
        assert_eq!(start.elapsed().as_millis(),2500);assert!(trace.snapshot().model_request_sent.is_none());
        drop(slots);assert_eq!(c.http_slots.available_permits(),2);
        let (mut next,server)=server("data: {\"type\":\"response.completed\"}\n\n",0).await;
        next.http_slots=c.http_slots.clone();
        next.text("fixture-token","m","i","final corrected frame",CancellationToken::new()).await.unwrap();
        assert_eq!(server.await.unwrap()["input"][0]["content"],"final corrected frame");
    }
    #[test]
    fn utf8_and_split_crlf() {
        let data = "event: x\r\ndata: {\"delta\":\"hello 🎉\"}\r\n\r\n".as_bytes();
        let mut p = SseParser::default();
        let mut events = vec![];
        for b in data {
            events.extend(p.push(&[*b]).unwrap())
        }
        assert_eq!(events.len(), 1);
        assert!(events[0].contains('🎉'));
    }
    #[test]
    fn contract_and_account_catalog() {
        let b = request_body("account-slug", "instructions", "context");
        assert_eq!(b["store"], false);
        assert_eq!(b["stream"], true);
        assert!(b.get("temperature").is_none());
        assert!(b.get("max_output_tokens").is_none());
        let m=parse_models(serde_json::json!({"models":[{"visibility":"list","slug":"fast-mini","display_name":"Fast"},{"visibility":"hidden","slug":"other","display_name":"Other"}]})).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(preferred(&m).unwrap().slug, "fast-mini");
        let models = parse_models(serde_json::json!({"models":[
            {"visibility":"list","slug":"gpt-6-astra","display_name":"Astra"},
            {"visibility":"list","slug":"gpt-5.6-sol","display_name":"Sol"},
            {"visibility":"list","slug":"gpt-5.6-luna","display_name":"Luna"}
        ]}))
        .unwrap();
        assert_eq!(preferred(&models).unwrap().slug, "gpt-5.6-luna");
    }
}
