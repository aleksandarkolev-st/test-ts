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
    trace: Option<super::timing::Trace>,
    refill_policy: super::codex::RefillPolicy,
    pub http: reqwest::Client,
    base: String,
    reasoning_effort: Option<String>,
    backend: AnswerBackend,
    service_tier: Option<String>,
    pub codex: Option<std::sync::Arc<super::codex::Codex>>,
}
#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnswerBackend { #[default] Chatgpt, Codex }
impl Default for Client {
    fn default() -> Self {
        Self {
            trace: None,
            refill_policy: super::codex::RefillPolicy::default(),
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(120))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
            base: {
                #[cfg(all(feature = "acceptance", debug_assertions))]
                if super::acceptance_mode() {
                    let base =
                        std::env::var("COPILOT_TEST_API").expect("Local test server required");
                    let u = url::Url::parse(&base).expect("Test API URL");
                    assert!(u.scheme() == "http" && u.host_str() == Some("127.0.0.1"));
                    return Self {
                        trace: None,
                        refill_policy: super::codex::RefillPolicy::default(),
                        http: reqwest::Client::new(),
                        base,
                        reasoning_effort: None,
                        backend: AnswerBackend::Chatgpt,
                        service_tier: None,
                        codex: None,
                    };
                }
                "https://api.openai.com/v1".into()
            },
            reasoning_effort: None,
            backend: AnswerBackend::Chatgpt,
            service_tier: None,
            codex: None,
        }
    }
}
#[derive(Debug)]
pub enum StreamEvent {
    Delta(String),
    Completed,
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
    pub fn with_reasoning(mut self, effort: Option<&str>) -> Self {
        self.reasoning_effort = effort.map(String::from);
        self
    }
    fn body(&self, model: &str, instructions: &str, input: &str, image: Option<&str>) -> serde_json::Value {
        let mut body = request_body_with_image(model, instructions, input, image);
        if let Some(effort) = &self.reasoning_effort {
            body["reasoning"] = serde_json::json!({"effort": effort});
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
        parse_models(
            r.json()
                .await
                .map_err(|_| "Invalid model catalog".to_string())?,
        )
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
        image: Option<&str>, cancel: CancellationToken, mut event: F,
    ) -> Result<(), String>
    where
        F: FnMut(StreamEvent) -> Fut + Send,
        Fut: std::future::Future<Output = Result<(), String>> + Send,
    {
        if self.backend == AnswerBackend::Codex {
            return self.codex.as_ref().ok_or("Codex runtime is unavailable")?
                .stream_traced(model, self.service_tier.as_deref(), self.reasoning_effort.as_deref(), instructions, input, image, cancel, self.refill_policy, self.trace.clone(), event).await;
        }
        let request = self
            .http
            .post(format!("{}/responses", self.base))
            .bearer_auth(token)
            .json(&self.body(model, instructions, input, image))
            .send();
        let response = tokio::select! {_=cancel.cancelled()=>return Err("cancelled".into()),r=request=>r.map_err(|_|"Answer request connection failed".to_string())?};
        let response = tokio::select! {_=cancel.cancelled()=>return Err("cancelled".into()),r=check_http(response)=>r?};
        let mut chunks = response.bytes_stream();
        let mut parser = SseParser::default();
        let mut complete = false;
        loop {
            let next = tokio::select! {_=cancel.cancelled()=>return Err("cancelled".into()),c=chunks.next()=>c};
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|_| "Answer stream was interrupted".to_string())?;
            for data in parser.push(&chunk)? {
                if data == "[DONE]" {
                    continue;
                }
                let value: serde_json::Value = serde_json::from_str(&data)
                    .map_err(|_| "Invalid answer stream event".to_string())?;
                match value["type"].as_str().unwrap_or("") {
                    "response.output_text.delta" => {
                        if let Some(d) = value["delta"].as_str() {
                            tokio::select! {_=cancel.cancelled()=>return Err("cancelled".into()),r=event(StreamEvent::Delta(d.into()))=>r?};
                        }
                    }
                    "response.completed" => {
                        complete = true;
                        tokio::select! {_=cancel.cancelled()=>return Err("cancelled".into()),r=event(StreamEvent::Completed)=>r?};
                    }
                    "error" | "response.failed" | "response.incomplete" => {
                        return Err(stream_error(&value))
                    }
                    _ => {}
                }
            }
            if complete {
                return Ok(());
            }
        }
        Err("Answer stream ended before response.completed".into())
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
    async fn server(
        body: &str,
        delay: u64,
    ) -> (Client, tokio::task::JoinHandle<serde_json::Value>) {
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
            for chunk in body.as_bytes().chunks(7) {
                if socket.write_all(chunk).await.is_err() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            parsed
        });
        (
            Client {
                trace: None,
                refill_policy: super::super::codex::RefillPolicy::default(),
                http: reqwest::Client::new(),
                base,
                reasoning_effort: None,
                backend: AnswerBackend::Chatgpt,
                service_tier: None,
                codex: None,
            },
            task,
        )
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
        s.await.unwrap();
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
