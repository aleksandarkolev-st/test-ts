use crate::storage::{credentials, db::Database};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
use url::Url;
pub const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> String {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub client_id: String,
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
    id_token: String,
    scopes: Vec<String>,
    expires_at: u64,
    earliest_refresh_at: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub client_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub plan_enabled: bool,
}
impl Profile {
    pub fn account(&self) -> Account {
        Account {
            client_id: self.client_id.clone(),
            email: self.email.clone(),
            name: self.name.clone(),
            plan_enabled: !self.access_token.is_empty()
                && self.scopes.iter().any(|s| s == "resource.invoke")
                && self.scopes.iter().any(|s| s == "chatgpt.tokens.use.direct"),
        }
    }
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
    earliest_refresh_at: Option<u64>,
}
#[derive(Clone, Deserialize)]
struct Identity {
    sub: String,
    nonce: Option<String>,
    email: Option<String>,
    name: Option<String>,
}
#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
}
pub struct Auth {
    pub profiles: Mutex<Vec<Profile>>,
    pub selected: Mutex<Option<String>>,
    pending: Mutex<Option<CancellationToken>>,
    pub http: reqwest::Client,
    db: Arc<Database>,
    closing: AtomicBool,
}
async fn complete_token_request(
    request: impl std::future::Future<Output = Result<String, String>> + Send + 'static,
) -> Result<String, String> {
    // Dropping the caller's JoinHandle detaches this account operation. A
    // canceled answer must not discard a replacement refresh token before
    // the serialized request has validated and persisted it.
    tokio::spawn(request)
        .await
        .map_err(|_| "ChatGPT credential operation did not finish".to_string())?
}
impl Auth {
    pub fn new(db: Arc<Database>) -> Result<Self, String> {
        let saved = if super::acceptance_mode() {
            None
        } else {
            credentials::load()?
        };
        let profiles = saved
            .map(|s| {
                serde_json::from_str::<Vec<Profile>>(&s)
                    .map_err(|_| "Saved credentials are damaged".to_string())
            })
            .transpose()?
            .unwrap_or_default();
        let selected = db.get("selected_account")?;
        Ok(Self {
            profiles: Mutex::new(profiles),
            selected: Mutex::new(selected),
            pending: Mutex::new(None),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?,
            db,
            closing: AtomicBool::new(false),
        })
    }
    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::Release);
    }
    pub async fn wait_for_token_requests(&self) {
        // Refresh holds this mutex through validation and atomic persistence.
        // New token requests are rejected once shutdown begins.
        let _profiles = self.profiles.lock().await;
    }
    pub async fn accounts(&self) -> Vec<Account> {
        self.profiles
            .lock()
            .await
            .iter()
            .map(Profile::account)
            .collect()
    }
    pub async fn selected_account(&self) -> Option<Account> {
        if super::acceptance_mode() {
            return Some(Account {
                client_id: "fixture-client".into(),
                email: Some("fixture@example.invalid".into()),
                name: Some("Native acceptance fixture".into()),
                plan_enabled: true,
            });
        }
        let id = self.selected.lock().await.clone();
        self.profiles
            .lock()
            .await
            .iter()
            .find(|p| Some(&p.client_id) == id.as_ref())
            .map(Profile::account)
    }
    pub async fn select(&self, id: &str) -> Result<(), String> {
        if !self.profiles.lock().await.iter().any(|p| p.client_id == id) {
            return Err("Unknown saved account".into());
        }
        self.db.set("selected_account", id)?;
        *self.selected.lock().await = Some(id.into());
        Ok(())
    }
    async fn discovery(&self) -> Result<Discovery, String> {
        let d: Discovery = self
            .http
            .get(format!("{ISSUER}/.well-known/openid-configuration"))
            .send()
            .await
            .map_err(|_| "Could not reach OpenAI sign-in discovery")?
            .error_for_status()
            .map_err(|_| "OpenAI sign-in discovery unavailable")?
            .json()
            .await
            .map_err(|_| "Invalid OpenAI discovery document")?;
        if d.issuer != ISSUER
            || [&d.authorization_endpoint, &d.token_endpoint, &d.jwks_uri]
                .iter()
                .any(|s| {
                    Url::parse(s)
                        .map(|u| {
                            u.scheme() != "https"
                                || u.host_str() != Some("auth.openai.com")
                                || !u.username().is_empty()
                                || u.password().is_some()
                        })
                        .unwrap_or(true)
                })
        {
            return Err("Untrusted OpenAI authentication discovery".into());
        }
        Ok(d)
    }
    async fn identity(
        &self,
        id_token: &str,
        client_id: &str,
        nonce: Option<&str>,
        jwks_uri: &str,
    ) -> Result<Identity, String> {
        let keys: JwkSet = self
            .http
            .get(jwks_uri)
            .send()
            .await
            .map_err(|_| "OpenAI identity keys unavailable")?
            .error_for_status()
            .map_err(|_| "OpenAI identity keys unavailable")?
            .json()
            .await
            .map_err(|_| "Invalid OpenAI identity keys")?;
        validate_identity(id_token, client_id, nonce, &keys)
    }
    pub async fn sign_in(&self, client_id: Option<String>) -> Result<Account, String> {
        let cancel = CancellationToken::new();
        {
            let mut pending = self.pending.lock().await;
            if pending.is_some() {
                return Err("Sign-in is already in progress".into());
            }
            *pending = Some(cancel.clone());
        }
        let result = tokio::select! {_=cancel.cancelled()=>Err("Sign-in cancelled".into()),r=self.sign_in_inner(client_id,cancel.clone())=>r};
        *self.pending.lock().await = None;
        result
    }
    pub async fn cancel_sign_in(&self) {
        if let Some(c) = self.pending.lock().await.as_ref() {
            c.cancel();
        }
    }
    async fn sign_in_inner(
        &self,
        client_id: Option<String>,
        cancel: CancellationToken,
    ) -> Result<Account, String> {
        let previous = if let Some(ref id) = client_id {
            Some(
                self.profiles
                    .lock()
                    .await
                    .iter()
                    .find(|p| &p.client_id == id)
                    .cloned()
                    .ok_or("Unknown saved account")?,
            )
        } else {
            None
        };
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "Could not open local sign-in callback")?;
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener.local_addr().map_err(|e| e.to_string())?.port()
        );
        let state = random();
        let nonce = random();
        let verifier = random();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let discovery = self.discovery().await?;
        let host = self.db.host_id()?;
        let mut url = Url::parse(&discovery.authorization_endpoint).map_err(|e| e.to_string())?;
        {
            let mut q = url.query_pairs_mut();
            q.extend_pairs([
                (
                    "client_id",
                    client_id.as_deref().unwrap_or("dynamic_agent_client"),
                ),
                ("response_type", "code"),
                ("redirect_uri", &redirect),
                ("scope", SCOPES),
                ("resource", RESOURCE),
                ("ext_agent_host_id", &host),
                ("state", &state),
                ("nonce", &nonce),
                ("code_challenge_method", "S256"),
                ("code_challenge", &challenge),
            ]);
            if let Some(ref p) = previous {
                if !p.id_token.is_empty() {
                    q.append_pair("id_token_hint", &p.id_token);
                }
                if let Some(ref email) = p.email {
                    q.append_pair("login_hint", email);
                }
            } else {
                q.append_pair("agent_name_hint", "Meeting Copilot");
            }
        }
        webbrowser::open(url.as_str())
            .map_err(|_| "Could not open the system browser for sign-in")?;
        // Authorization URLs contain identity hints. Never log them.
        let params=tokio::time::timeout(std::time::Duration::from_secs(300),async {
            loop {
                let (mut socket,_)=tokio::select!{_=cancel.cancelled()=>return Err::<Callback,String>("Sign-in cancelled".into()),r=listener.accept()=>r.map_err(|_|"Callback listener failed")?};
                let request=tokio::time::timeout(std::time::Duration::from_secs(2),async {let mut data=vec![];loop{let mut buffer=[0u8;1024];let n=socket.read(&mut buffer).await.map_err(|_|"Invalid callback request")?;if n==0{return Err("Incomplete callback request")};data.extend_from_slice(&buffer[..n]);if data.len()>8192{return Err("Callback request too large")};if data.windows(4).any(|w|w==b"\r\n\r\n"){return String::from_utf8(data).map_err(|_|"Invalid callback encoding")}}}).await;
                let parsed=request.ok().and_then(Result::ok).and_then(|r|{let mut words=r.lines().next()?.split_whitespace();if words.next()?!="GET"{return None;}Url::parse(&format!("http://127.0.0.1{}",words.next()?)).ok()});
                let valid=parsed.as_ref().filter(|u|u.path()=="/auth/callback").and_then(|u|parse_callback(u,&state,client_id.as_deref()).ok());
                if let Some(p)=valid {let html="Sign-in received. You may close this tab and return to Meeting Copilot.";let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",html.len());let _=socket.write_all(response.as_bytes()).await;return Ok(p);}
                let _=socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            }
        }).await.map_err(|_|"Sign-in timed out; try again")??;
        if params.error.is_some() {
            return Err("ChatGPT sign-in was declined".into());
        }
        let issued = params
            .client_id
            .ok_or("Registration did not issue a client ID")?;
        let token: TokenResponse = self
            .http
            .post(&discovery.token_endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", &issued),
                (
                    "code",
                    params.code.as_deref().ok_or("Missing authorization code")?,
                ),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| "OAuth code exchange failed")?
            .error_for_status()
            .map_err(|_| "OAuth code exchange rejected; sign in again")?
            .json()
            .await
            .map_err(|_| "Invalid OAuth token response")?;
        let id_token = token
            .id_token
            .clone()
            .ok_or("Sign-in did not return an identity token")?;
        let identity = self
            .identity(&id_token, &issued, Some(&nonce), &discovery.jwks_uri)
            .await?;
        if previous.as_ref().is_some_and(|p| p.subject != identity.sub) {
            return Err("Returned identity differs from the selected account".into());
        }
        let profile = profile_from_tokens(issued, identity, token)?;
        let account = profile.account();
        let mut profiles = self.profiles.lock().await;
        let mut next = profiles.clone();
        next.retain(|p| p.client_id != profile.client_id);
        next.push(profile);
        persist(&next)?;
        *profiles = next;
        drop(profiles);
        self.select(&account.client_id).await?;
        Ok(account)
    }
    pub async fn token(self: &Arc<Self>) -> Result<String, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Meeting Copilot is closing".into());
        }
        if super::acceptance_mode() {
            return Ok("fixture-token".into());
        }
        let auth = self.clone();
        // This task owns account state only, never meeting text or audio.
        complete_token_request(async move { auth.token_inner().await }).await
    }
    async fn token_inner(&self) -> Result<String, String> {
        let selected = self
            .selected
            .lock()
            .await
            .clone()
            .ok_or("Continue with ChatGPT first")?;
        let mut profiles = self.profiles.lock().await;
        if self.closing.load(Ordering::Acquire) {
            return Err("Meeting Copilot is closing".into());
        }
        let index = profiles
            .iter()
            .position(|p| p.client_id == selected)
            .ok_or("Saved ChatGPT account is unavailable")?;
        if !profiles[index].account().plan_enabled {
            return Err("Enable ChatGPT plan usage by signing in again".into());
        }
        if profiles[index].expires_at > now() + 60 {
            return Ok(profiles[index].access_token.clone());
        }
        let prior = profiles[index].clone();
        if now() < prior.earliest_refresh_at {
            return Err("ChatGPT credentials cannot refresh yet; try shortly".into());
        }
        let refresh = prior
            .refresh_token
            .as_deref()
            .ok_or("Sign in again to renew ChatGPT access")?;
        let discovery = self.discovery().await?;
        let token: TokenResponse = self
            .http
            .post(&discovery.token_endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", prior.client_id.as_str()),
                ("refresh_token", refresh),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| "ChatGPT refresh connection failed")?
            .error_for_status()
            .map_err(|_| "ChatGPT access expired or revoked; sign in again")?
            .json()
            .await
            .map_err(|_| "Invalid ChatGPT refresh response")?;
        validate_token_type(&token)?;
        let mut updated = prior.clone();
        updated.access_token = token
            .access_token
            .filter(|s| !s.is_empty())
            .ok_or("Refresh returned no access token")?;
        updated.refresh_token = Some(
            token
                .refresh_token
                .filter(|s| !s.is_empty())
                .ok_or("Refresh returned no replacement refresh token")?,
        );
        updated.expires_at = now().saturating_add(token.expires_in.unwrap_or(3600));
        updated.earliest_refresh_at = token.earliest_refresh_at.unwrap_or(0);
        if let Some(scope) = token.scope {
            updated.scopes = scope.split_whitespace().map(String::from).collect();
        }
        if let Some(id) = token.id_token {
            let identity = self
                .identity(&id, &prior.client_id, None, &discovery.jwks_uri)
                .await?;
            if identity.sub != prior.subject {
                return Err("Refresh returned a different account".into());
            }
            updated.id_token = id;
        }
        let mut next = profiles.clone();
        next[index] = updated;
        persist(&next)?;
        *profiles = next;
        if !profiles[index].account().plan_enabled {
            return Err("ChatGPT plan usage permission was removed".into());
        }
        Ok(profiles[index].access_token.clone())
    }
    pub async fn sign_out(&self, id: &str) -> Result<Option<String>, String> {
        let mut profiles = self.profiles.lock().await;
        let index = profiles
            .iter()
            .position(|p| p.client_id == id)
            .ok_or("Unknown saved account")?;
        let mut revoked = true;
        if let Some(token) = profiles[index].refresh_token.as_ref() {
            revoked = false;
            if let Ok(d) = self.discovery().await {
                if let Some(endpoint) = d.revocation_endpoint {
                    if Url::parse(&endpoint).is_ok_and(|u| {
                        u.scheme() == "https" && u.host_str() == Some("auth.openai.com")
                    }) {
                        for attempt in 0..3 {
                            if self
                                .http
                                .post(&endpoint)
                                .form(&[
                                    ("token", token.as_str()),
                                    ("token_type_hint", "refresh_token"),
                                    ("client_id", id),
                                ])
                                .send()
                                .await
                                .is_ok_and(|r| r.status() == reqwest::StatusCode::OK)
                            {
                                revoked = true;
                                break;
                            }
                            if attempt < 2 {
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    300 * (attempt + 1),
                                ))
                                .await;
                            }
                        }
                    }
                }
            }
        }
        let mut next = profiles.clone();
        next[index].access_token.clear();
        next[index].refresh_token = None;
        next[index].id_token.clear();
        next[index].scopes.clear();
        next[index].expires_at = 0;
        persist(&next)?;
        *profiles = next;
        let mut selected = self.selected.lock().await;
        if selected.as_deref() == Some(id) {
            *selected = None;
            self.db.set("selected_account", "")?
        }
        Ok((!revoked).then(||"Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.".into()))
    }
}
fn persist(profiles: &[Profile]) -> Result<(), String> {
    credentials::save(
        &serde_json::to_string(profiles).map_err(|_| "Could not serialize credentials")?,
    )
}
fn profile_from_tokens(
    client_id: String,
    id: Identity,
    t: TokenResponse,
) -> Result<Profile, String> {
    validate_token_type(&t)?;
    Ok(Profile {
        client_id,
        subject: id.sub,
        email: id.email,
        name: id.name,
        access_token: t.access_token.unwrap_or_default(),
        refresh_token: t.refresh_token,
        id_token: t.id_token.ok_or("Missing identity token")?,
        scopes: t
            .scope
            .unwrap_or_default()
            .split_whitespace()
            .map(String::from)
            .collect(),
        expires_at: now().saturating_add(t.expires_in.unwrap_or(3600)),
        earliest_refresh_at: t.earliest_refresh_at.unwrap_or(0),
    })
}
fn validate_token_type(t: &TokenResponse) -> Result<(), String> {
    if t.token_type
        .as_deref()
        .is_some_and(|s| !s.eq_ignore_ascii_case("bearer"))
    {
        return Err("Unexpected OAuth token type".into());
    }
    Ok(())
}
fn validate_identity(
    token: &str,
    client_id: &str,
    nonce: Option<&str>,
    keys: &JwkSet,
) -> Result<Identity, String> {
    let h = decode_header(token).map_err(|_| "Invalid identity token")?;
    if !matches!(h.alg, Algorithm::RS256 | Algorithm::ES256) {
        return Err("Unsupported identity signature algorithm".into());
    }
    let key = keys
        .find(h.kid.as_deref().ok_or("Identity token has no key ID")?)
        .ok_or("Unknown identity signing key")?;
    let mut v = Validation::new(h.alg);
    v.set_audience(&[client_id]);
    v.set_issuer(&[ISSUER]);
    v.leeway = 5;
    v.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
    let id = decode::<Identity>(
        token,
        &DecodingKey::from_jwk(key).map_err(|_| "Invalid identity signing key")?,
        &v,
    )
    .map_err(|_| "Identity signature, issuer, audience or expiration validation failed")?
    .claims;
    if id.sub.is_empty() || nonce.is_some_and(|n| id.nonce.as_deref() != Some(n)) {
        return Err("Identity nonce or subject validation failed".into());
    }
    Ok(id)
}
struct Callback {
    client_id: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
fn parse_callback(url: &Url, state: &str, previous: Option<&str>) -> Result<Callback, String> {
    let pairs: Vec<_> = url.query_pairs().collect();
    let get = |key: &str| -> Result<Option<String>, String> {
        let values: Vec<_> = pairs
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.to_string())
            .collect();
        if values.len() > 1 {
            Err("Duplicate OAuth callback parameter".into())
        } else {
            Ok(values.first().cloned())
        }
    };
    if get("state")?.as_deref() != Some(state) {
        return Err("OAuth state mismatch".into());
    }
    let supplied = get("client_id")?;
    if previous.is_some_and(|p| supplied.as_deref().is_some_and(|s| s != p)) {
        return Err("OAuth client ID mismatch".into());
    }
    let error = get("error")?;
    let client_id = supplied.or_else(|| previous.map(String::from));
    if error.is_none()
        && client_id
            .as_deref()
            .is_none_or(|s| s.is_empty() || s == "dynamic_agent_client")
    {
        return Err("OAuth registration incomplete".into());
    }
    Ok(Callback {
        client_id,
        code: get("code")?,
        error,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn canceled_caller_does_not_drop_rotated_credential_persistence() {
        let (started, began) = tokio::sync::oneshot::channel();
        let (release, finish) = tokio::sync::oneshot::channel();
        let (persisted, saved) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(complete_token_request(async move {
            let _ = started.send(());
            finish.await.map_err(|_| "Fixture closed".to_string())?;
            // Represents the persistence step after receiving a replacement.
            let _ = persisted.send(());
            Ok("synthetic-token".to_string())
        }));
        began.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), saved)
            .await
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn token_request_preserves_success_and_failure() {
        assert_eq!(
            complete_token_request(async { Ok("synthetic-token".into()) })
                .await
                .unwrap(),
            "synthetic-token"
        );
        assert_eq!(
            complete_token_request(async { Err("synthetic-failure".into()) })
                .await
                .unwrap_err(),
            "synthetic-failure"
        );
    }
    #[test]
    fn plan_permission_requires_access_token_and_both_scopes() {
        let make = |access: &str, scope: &str, token_type: &str| {
            profile_from_tokens(
                "fixture-client".into(),
                Identity {
                    sub: "fixture-account".into(),
                    nonce: None,
                    email: None,
                    name: None,
                },
                serde_json::from_value(serde_json::json!({
                    "access_token": access, "scope": scope, "token_type": token_type,
                    "id_token": "synthetic", "expires_in": u64::MAX,
                }))
                .unwrap(),
            )
        };
        let scopes = "resource.invoke chatgpt.tokens.use.direct";
        assert!(
            make("synthetic", scopes, "Bearer")
                .unwrap()
                .account()
                .plan_enabled
        );
        assert!(!make("", scopes, "Bearer").unwrap().account().plan_enabled);
        assert!(
            !make("synthetic", "chatgpt.tokens.use.direct", "Bearer")
                .unwrap()
                .account()
                .plan_enabled
        );
        assert!(make("synthetic", scopes, "MAC").is_err());
    }
    #[test]
    fn validates_signed_identity_and_rejects_nonce_audience_expiry_and_signature() {
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(include_bytes!(
            "../../test-fixtures/identity-private.pem"
        ))
        .unwrap();
        let keys: JwkSet =
            serde_json::from_str(include_str!("../../test-fixtures/identity-jwks.json")).unwrap();
        let claims = serde_json::json!({"sub":"fixture-account","iss":ISSUER,"aud":"oaiapp_fixture","iat":now(),"exp":now()+60,"nonce":"nonce"});
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("fixture".into());
        let valid = jsonwebtoken::encode(&header, &claims, &key).unwrap();
        assert_eq!(
            validate_identity(&valid, "oaiapp_fixture", Some("nonce"), &keys)
                .unwrap()
                .sub,
            "fixture-account"
        );
        assert!(validate_identity(&valid, "another-client", Some("nonce"), &keys).is_err());
        assert!(
            validate_identity(&valid, "oaiapp_fixture", Some("different-nonce"), &keys).is_err()
        );
        for (field, value) in [
            ("iss", serde_json::json!("https://attacker.invalid")),
            ("exp", serde_json::json!(now() - 60)),
            ("sub", serde_json::json!("")),
        ] {
            let mut bad = claims.clone();
            bad[field] = value;
            let token = jsonwebtoken::encode(&header, &bad, &key).unwrap();
            assert!(validate_identity(&token, "oaiapp_fixture", Some("nonce"), &keys).is_err());
        }
        let parts: Vec<_> = valid.split('.').collect();
        let forged = format!(
            "{}.{}.{}",
            parts[0],
            URL_SAFE_NO_PAD.encode(b"{\"sub\":\"attacker\"}"),
            parts[2]
        );
        assert!(validate_identity(&forged, "oaiapp_fixture", Some("nonce"), &keys).is_err());
    }
    #[test]
    fn rejects_forged_callback() {
        for q in [
            "state=wrong&code=x&client_id=oaiapp_a",
            "state=s&state=s&code=x&client_id=oaiapp_a",
            "state=s&code=x&client_id=dynamic_agent_client",
        ] {
            assert!(parse_callback(
                &Url::parse(&format!("http://127.0.0.1/auth/callback?{q}")).unwrap(),
                "s",
                None
            )
            .is_err());
        }
        assert!(parse_callback(
            &Url::parse("http://127.0.0.1/auth/callback?state=s&code=x&client_id=oaiapp_b")
                .unwrap(),
            "s",
            Some("oaiapp_a")
        )
        .is_err());
    }
    #[test]
    fn pkce_has_256_bit_entropy() {
        let verifier = random();
        assert_eq!(verifier.len(), 43);
        assert_ne!(verifier, random());
        assert_eq!(
            URL_SAFE_NO_PAD
                .encode(Sha256::digest(verifier.as_bytes()))
                .len(),
            43
        );
    }
}
