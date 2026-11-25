//! `serve`: keeps one Steam session open and answers HTTP requests with the same JSON as
//! deadlock-api, so the website can fall back to the bot when deadlock-api says "too many
//! requests". It is meant for a private network (Docker Compose): it has no TLS.
//!
//! | Route | Same as deadlock-api | Cached |
//! | --- | --- | --- |
//! | `GET /v1/matches/active` | yes (no `account_id` lookup) | 60 s |
//! | `GET /v1/matches/{id}/metadata` | `match_info` with the fields the website reads | forever once known |
//! | `GET /v1/matches/{id}/live/url` | yes | 1 hour |
//! | `GET /healthz` | no | no |
//!
//! The waits from [`crate::guard`] still apply. A request that would break them gets
//! `429 Too Many Requests` with `Retry-After`, or the last cached answer when there is one.

use core::time::Duration;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::gc::GcSession;
use crate::matches::{self, GcAnswer};
use crate::{auth, guard};

/// How long answers are kept and how often each kind of request may reach Steam.
#[derive(Clone, Debug)]
pub struct Limits {
    pub active: Duration,
    pub result: Duration,
    pub spectate: Duration,
    /// A match that is not finished yet is not asked about again for this long.
    pub not_ready: Duration,
    /// Broadcast URLs stay valid while the match is live; deadlock-api caches them for an hour.
    pub spectate_ttl: Duration,
    /// An old live list is still served for this long when Steam can't be asked.
    pub stale_active: Duration,
    /// No spectate for this long after Steam says it is rate limiting them.
    pub rate_limited_pause: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            active: guard::ACTIVE_GAP,
            result: guard::RESULT_GAP,
            spectate: guard::SPECTATE_GAP,
            not_ready: Duration::from_secs(60),
            spectate_ttl: Duration::from_secs(60 * 60),
            stale_active: Duration::from_secs(10 * 60),
            rate_limited_pause: guard::SPECTATE_RATE_LIMITED_PAUSE,
        }
    }
}

const MAX_CACHED_RESULTS: usize = 2_000;

/// Why a request to Steam did not return data.
#[derive(Debug)]
pub enum CallError {
    /// There is no saved login: someone has to run `deadlock-bot login` once.
    NotLoggedIn(String),
    /// Steam could not be reached or the login failed; try again after `retry_after_s`.
    Unavailable { message: String, retry_after_s: u64 },
    /// The game coordinator answered, but not with data.
    Answer(GcAnswer),
    /// Anything else.
    Failed(String),
}

/// Why [`Server::spectate`] gave no broadcast.
#[derive(Debug)]
pub enum Spectate {
    /// The spectate wait isn't over: seconds left.
    TooSoon(u64),
    Failed(CallError),
}

/// What the server needs from Steam. [`SteamBackend`] is the real one; tests use a fake.
pub trait Backend: Send + Sync + 'static {
    fn active(&self) -> impl Future<Output = Result<Value, CallError>> + Send;
    fn result(&self, match_id: u64) -> impl Future<Output = Result<Value, CallError>> + Send;
    fn spectate(&self, match_id: u64) -> impl Future<Output = Result<Value, CallError>> + Send;
    fn status(&self) -> impl Future<Output = Value> + Send;
    /// Ends the Steam session if nothing used it for a while.
    fn close_if_idle(&self) -> impl Future<Output = ()> + Send;
    fn shutdown(&self) -> impl Future<Output = ()> + Send;
}

// ---------------------------------------------------------------------------------------------
// The real backend: one Steam session, opened on first use and closed when idle.

pub struct SteamBackend {
    http: reqwest::Client,
    idle: Duration,
    slot: Mutex<Slot>,
}

#[derive(Default)]
struct Slot {
    gc: Option<GcSession>,
    last_used: Option<Instant>,
    /// No new login attempt before this, after a failed one.
    retry_at: Option<Instant>,
    failed_logins: u32,
    last_error: Option<String>,
}

impl SteamBackend {
    pub fn new(http: reqwest::Client, idle: Duration) -> Self {
        Self {
            http,
            idle,
            slot: Mutex::new(Slot::default()),
        }
    }

    /// The open session, logging in first when there is none.
    async fn session(slot: &mut Slot) -> Result<&GcSession, CallError> {
        let now = Instant::now();
        if slot.gc.is_none() {
            if let Some(at) = slot.retry_at
                && now < at
            {
                return Err(CallError::Unavailable {
                    message: format!(
                        "the last Steam login failed: {}",
                        slot.last_error.as_deref().unwrap_or("unknown error")
                    ),
                    retry_after_s: (at - now).as_secs().max(1),
                });
            }
            match GcSession::start().await {
                Ok(gc) => {
                    log::info!("Steam session open");
                    slot.gc = Some(gc);
                    slot.failed_logins = 0;
                    slot.retry_at = None;
                }
                Err(e) if e.downcast_ref::<auth::NotLoggedIn>().is_some() => {
                    slot.last_error = Some(e.to_string());
                    return Err(CallError::NotLoggedIn(e.to_string()));
                }
                Err(e) => {
                    // Back off 1, 2, 4 ... up to 10 minutes: repeated logins look the most like a bot.
                    slot.failed_logins += 1;
                    let wait = (60u64 << (slot.failed_logins - 1).min(4)).min(600);
                    slot.retry_at = Some(now + Duration::from_secs(wait));
                    slot.last_error = Some(format!("{e:#}"));
                    log::warn!("Steam login failed (next try in {wait}s): {e:#}");
                    return Err(CallError::Unavailable {
                        message: format!("Steam login failed: {e:#}"),
                        retry_after_s: wait,
                    });
                }
            }
        }
        slot.last_used = Some(now);
        Ok(slot.gc.as_ref().expect("session was just opened"))
    }

    /// Sorts out a finished call. An error that is not an answer from the game coordinator may
    /// mean the connection broke, so the session is closed and the next call opens a new one.
    async fn finish(slot: &mut Slot, out: Result<Value>) -> Result<Value, CallError> {
        match out {
            Ok(value) => Ok(value),
            Err(e) => match e.downcast::<GcAnswer>() {
                Ok(answer) => Err(CallError::Answer(answer)),
                Err(e) => {
                    let message = format!("{e:#}");
                    log::warn!("Steam request failed, reconnecting next time: {message}");
                    slot.last_error = Some(message.clone());
                    if let Some(gc) = slot.gc.take() {
                        gc.close().await;
                    }
                    Err(CallError::Failed(message))
                }
            },
        }
    }
}

impl Backend for SteamBackend {
    async fn active(&self) -> Result<Value, CallError> {
        let mut slot = self.slot.lock().await;
        let out = matches::active(Self::session(&mut slot).await?).await;
        Self::finish(&mut slot, out).await
    }

    async fn result(&self, match_id: u64) -> Result<Value, CallError> {
        let mut slot = self.slot.lock().await;
        let gc = Self::session(&mut slot).await?;
        let out = matches::result(gc, &self.http, match_id, None).await;
        Self::finish(&mut slot, out).await
    }

    async fn spectate(&self, match_id: u64) -> Result<Value, CallError> {
        let mut slot = self.slot.lock().await;
        let gc = Self::session(&mut slot).await?;
        let out = matches::spectate(gc, &self.http, match_id, None).await;
        Self::finish(&mut slot, out).await
    }

    async fn status(&self) -> Value {
        let logged_in = auth::has_saved_login();
        // Don't wait for a request that is talking to Steam right now.
        let Ok(slot) = self.slot.try_lock() else {
            return json!({ "logged_in": logged_in, "connected": true, "busy": true });
        };
        let now = Instant::now();
        json!({
            "logged_in": logged_in,
            "connected": slot.gc.is_some(),
            "busy": false,
            "idle_s": slot.last_used.map(|t| now.duration_since(t).as_secs()),
            "next_login_in_s": slot.retry_at.filter(|&t| t > now).map(|t| (t - now).as_secs()),
            "last_error": slot.last_error,
        })
    }

    async fn close_if_idle(&self) {
        let mut slot = self.slot.lock().await;
        let idle = slot.last_used.is_none_or(|t| t.elapsed() >= self.idle);
        if idle && let Some(gc) = slot.gc.take() {
            log::info!("Steam session idle for {:?}, closing it", self.idle);
            gc.close().await;
        }
    }

    async fn shutdown(&self) {
        if let Some(gc) = self.slot.lock().await.gc.take() {
            gc.close().await;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The HTTP side: caching, waits and status codes. The same for the real and the fake backend.

pub struct Server<B> {
    backend: B,
    limits: Limits,
    state_dir: PathBuf,
    token: Option<String>,
    /// Checking and recording a wait happens under this lock, so two requests can't both pass.
    waits: std::sync::Mutex<()>,
    /// Also makes concurrent live-list requests wait for one refresh instead of each asking Steam.
    active: Mutex<Option<(Instant, Value)>>,
    results: std::sync::Mutex<Results>,
    spectates: std::sync::Mutex<HashMap<u64, (Instant, Value)>>,
    /// Set when Steam rate limits a spectate: none is sent before then.
    spectate_paused_until: std::sync::Mutex<Option<Instant>>,
}

#[derive(Default)]
struct Results {
    done: HashMap<u64, Value>,
    order: VecDeque<u64>,
    not_ready: HashMap<u64, (Instant, String)>,
}

impl<B: Backend> Server<B> {
    pub fn new(backend: B, limits: Limits, state_dir: PathBuf, token: Option<String>) -> Self {
        Self {
            backend,
            limits,
            state_dir,
            token: token.filter(|t| !t.is_empty()),
            waits: std::sync::Mutex::new(()),
            active: Mutex::new(None),
            results: std::sync::Mutex::new(Results::default()),
            spectates: std::sync::Mutex::new(HashMap::new()),
            spectate_paused_until: std::sync::Mutex::new(None),
        }
    }

    /// Records a request of this kind, or says how many seconds are left to wait.
    fn permit(&self, command: &str, gap: Duration) -> Result<(), u64> {
        let _lock = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        let path = guard::file_in(&self.state_dir);
        match guard::check_at(path, command, gap, false, guard::now_secs()) {
            Ok(ticket) => {
                if let Err(e) = ticket.record() {
                    log::warn!("could not save the request time: {e:#}");
                }
                Ok(())
            }
            Err(too_soon) => Err(too_soon.wait_s.max(1)),
        }
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        let Some(token) = &self.token else {
            return true;
        };
        let given = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        constant_time_eq(given.as_bytes(), token.as_bytes())
    }

    async fn active_matches(&self) -> Response {
        let mut cache = self.active.lock().await;
        if let Some((at, value)) = cache.as_ref()
            && at.elapsed() < self.limits.active
        {
            return cached(value.clone(), *at, self.limits.active);
        }
        if let Err(wait) = self.permit("active", self.limits.active) {
            return match cache.as_ref() {
                Some((at, value)) => cached(value.clone(), *at, self.limits.active),
                None => too_many_requests(wait, "the live match list was fetched moments ago"),
            };
        }
        match self.backend.active().await {
            Ok(value) => {
                let now = Instant::now();
                *cache = Some((now, value.clone()));
                cached(value, now, self.limits.active)
            }
            Err(e) => match cache.as_ref() {
                Some((at, value)) if at.elapsed() < self.limits.stale_active => {
                    log::warn!("serving an old live match list: {}", describe(&e));
                    cached(value.clone(), *at, self.limits.active)
                }
                _ => error_response(&e),
            },
        }
    }

    async fn metadata(&self, match_id: u64) -> Response {
        {
            let results = self.results.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(info) = results.done.get(&match_id) {
                return ok(metadata_json(match_id, info.clone()));
            }
            if let Some((at, message)) = results.not_ready.get(&match_id)
                && at.elapsed() < self.limits.not_ready
            {
                let left = (self.limits.not_ready - at.elapsed()).as_secs().max(1);
                return not_ready(message, Some(left));
            }
        }
        if let Err(wait) = self.permit("result", self.limits.result) {
            return too_many_requests(wait, "a match result was fetched moments ago");
        }
        let out = self.backend.result(match_id).await;
        let mut results = self.results.lock().unwrap_or_else(|e| e.into_inner());
        match out {
            Ok(info) => {
                results.not_ready.remove(&match_id);
                results.done.insert(match_id, info.clone());
                results.order.push_back(match_id);
                while results.order.len() > MAX_CACHED_RESULTS {
                    if let Some(old) = results.order.pop_front() {
                        results.done.remove(&old);
                    }
                }
                ok(metadata_json(match_id, info))
            }
            Err(CallError::Answer(GcAnswer::NotReady(message))) => {
                let left = self.limits.not_ready.as_secs();
                results
                    .not_ready
                    .insert(match_id, (Instant::now(), message.clone()));
                results
                    .not_ready
                    .retain(|_, (at, _)| at.elapsed() < self.limits.not_ready);
                not_ready(&message, Some(left))
            }
            Err(e) => error_response(&e),
        }
    }

    async fn live_url(&self, match_id: u64) -> Response {
        match self.spectate(match_id).await {
            Ok(value) => ok(value),
            Err(Spectate::TooSoon(wait)) => too_many_requests(wait, "a match was spectated moments ago"),
            Err(Spectate::Failed(CallError::Answer(GcAnswer::NotReady(message)))) => not_ready(&message, None),
            Err(Spectate::Failed(e)) => error_response(&e),
        }
    }

    /// A broadcast spectated less than `spectate_ttl` ago, without spectating again (no Steam request, no wait).
    pub fn spectated(&self, match_id: u64) -> Option<Value> {
        let spectates = self.spectates.lock().unwrap_or_else(|e| e.into_inner());
        spectates
            .get(&match_id)
            .filter(|(at, _)| at.elapsed() < self.limits.spectate_ttl)
            .map(|(_, value)| value.clone())
    }

    /// Seconds left of the pause a rate-limited spectate started, if one is on.
    fn spectate_pause_left(&self) -> Option<u64> {
        let until = (*self.spectate_paused_until.lock().unwrap_or_else(|e| e.into_inner()))?;
        let left = until.saturating_duration_since(Instant::now());
        (!left.is_zero()).then(|| left.as_secs().max(1))
    }

    /// The broadcast of a live match, from the cache or by spectating it (within the spectate wait,
    /// and not while Steam's rate limiting has paused spectates).
    pub async fn spectate(&self, match_id: u64) -> Result<Value, Spectate> {
        if let Some(value) = self.spectated(match_id) {
            return Ok(value);
        }
        if let Some(left) = self.spectate_pause_left() {
            return Err(Spectate::TooSoon(left));
        }
        self.permit("spectate", self.limits.spectate).map_err(Spectate::TooSoon)?;
        let value = match self.backend.spectate(match_id).await {
            Ok(value) => value,
            Err(e) => {
                if let CallError::Answer(GcAnswer::RateLimited(message)) = &e {
                    let pause = self.limits.rate_limited_pause;
                    *self.spectate_paused_until.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(Instant::now() + pause);
                    log::warn!("{message}: no spectates for the next {} minutes", pause.as_secs() / 60);
                }
                return Err(Spectate::Failed(e));
            }
        };
        let mut spectates = self.spectates.lock().unwrap_or_else(|e| e.into_inner());
        spectates.retain(|_, (at, _)| at.elapsed() < self.limits.spectate_ttl);
        spectates.insert(match_id, (Instant::now(), value.clone()));
        Ok(value)
    }
}

/// deadlock-api's `/v1/matches/{id}/metadata` shape: the website reads `match_info.winning_team`,
/// `match_info.duration_s` and `match_info.not_scored`.
fn metadata_json(match_id: u64, info: Value) -> Value {
    json!({ "match_id": match_id, "match_info": info })
}

pub fn router<B: Backend>(server: Arc<Server<B>>) -> Router {
    Router::new()
        .route("/healthz", get(healthz::<B>))
        .route("/v1/matches/active", get(active::<B>))
        .route("/v1/matches/{match_id}/metadata", get(metadata::<B>))
        .route("/v1/matches/{match_id}/live/url", get(live_url::<B>))
        .fallback(|| async { reply(StatusCode::NOT_FOUND, json!({ "error": "no such route" })) })
        .with_state(server)
}

async fn healthz<B: Backend>(State(s): State<Arc<Server<B>>>) -> Response {
    let mut status = s.backend.status().await;
    status["source"] = json!("deadlock-bot");
    ok(status)
}

async fn active<B: Backend>(
    State(s): State<Arc<Server<B>>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !s.authorized(&headers) {
        return unauthorized();
    }
    if query.contains_key("account_id") {
        return reply(
            StatusCode::BAD_REQUEST,
            json!({ "error": "the bot can't look up the match of one player (account_id)" }),
        );
    }
    s.active_matches().await
}

async fn metadata<B: Backend>(
    State(s): State<Arc<Server<B>>>,
    headers: HeaderMap,
    Path(match_id): Path<u64>,
) -> Response {
    if !s.authorized(&headers) {
        return unauthorized();
    }
    s.metadata(match_id).await
}

async fn live_url<B: Backend>(
    State(s): State<Arc<Server<B>>>,
    headers: HeaderMap,
    Path(match_id): Path<u64>,
) -> Response {
    if !s.authorized(&headers) {
        return unauthorized();
    }
    s.live_url(match_id).await
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn ok(body: Value) -> Response {
    reply(StatusCode::OK, body)
}

/// A cached answer, with its age, like a CDN would send it.
fn cached(body: Value, at: Instant, ttl: Duration) -> Response {
    let age = at.elapsed().as_secs();
    let mut response = ok(body);
    let headers = response.headers_mut();
    headers.insert(header::AGE, HeaderValue::from(age));
    let max_age = ttl.as_secs().saturating_sub(age);
    if let Ok(value) = HeaderValue::from_str(&format!("max-age={max_age}")) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    response
}

fn with_retry_after(mut response: Response, seconds: u64) -> Response {
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
    response
}

fn too_many_requests(wait_s: u64, why: &str) -> Response {
    with_retry_after(
        reply(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": format!("{why}; try again in {wait_s}s"), "retry_after_s": wait_s }),
        ),
        wait_s,
    )
}

/// 404 is what deadlock-api sends for a match it has no result for yet; the website then waits.
fn not_ready(message: &str, retry_after_s: Option<u64>) -> Response {
    let response = reply(StatusCode::NOT_FOUND, json!({ "error": message }));
    match retry_after_s {
        Some(s) => with_retry_after(response, s),
        None => response,
    }
}

fn unauthorized() -> Response {
    reply(
        StatusCode::UNAUTHORIZED,
        json!({ "error": "missing or wrong Authorization: Bearer token" }),
    )
}

fn describe(e: &CallError) -> String {
    match e {
        CallError::NotLoggedIn(m) | CallError::Failed(m) => m.clone(),
        CallError::Unavailable { message, .. } => message.clone(),
        CallError::Answer(answer) => answer.to_string(),
    }
}

fn error_response(e: &CallError) -> Response {
    let body = json!({ "error": describe(e) });
    match e {
        CallError::NotLoggedIn(_) => {
            with_retry_after(reply(StatusCode::SERVICE_UNAVAILABLE, body), 300)
        }
        CallError::Unavailable { retry_after_s, .. } => with_retry_after(
            reply(StatusCode::SERVICE_UNAVAILABLE, body),
            *retry_after_s,
        ),
        CallError::Answer(GcAnswer::Busy(_) | GcAnswer::RateLimited(_)) => {
            with_retry_after(reply(StatusCode::SERVICE_UNAVAILABLE, body), 60)
        }
        CallError::Answer(GcAnswer::NotReady(m)) => not_ready(m, None),
        CallError::Answer(GcAnswer::Refused(_)) | CallError::Failed(_) => {
            reply(StatusCode::BAD_GATEWAY, body)
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Runs the server until Ctrl+C or SIGTERM (`docker stop`), then closes the Steam session.
pub async fn serve(
    listen: SocketAddr,
    token: Option<String>,
    idle: Duration,
    feeds: Option<crate::feeds::Config>,
) -> Result<()> {
    let state_dir = auth::state_dir()?;
    std::fs::create_dir_all(&state_dir)
        .with_context(|| format!("could not create {}", state_dir.display()))?;
    if !auth::has_saved_login() {
        log::warn!(
            "no saved Steam login in {}: requests will fail until someone runs `deadlock-bot login`",
            state_dir.display()
        );
    }
    let http = reqwest::Client::builder()
        .user_agent(concat!("naebka-deadlock-bot/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let token = token.filter(|t| !t.is_empty());
    if token.is_none() && !listen.ip().is_loopback() {
        log::warn!(
            "listening on {listen} without DEADLOCK_BOT_TOKEN: keep this port off the internet"
        );
    }
    let server = Arc::new(Server::new(
        SteamBackend::new(http.clone(), idle),
        Limits::default(),
        state_dir,
        token,
    ));
    let feeds_task = feeds.map(|cfg| tokio::spawn(crate::feeds::run(cfg, server.clone(), http)));

    let idle_closer = {
        let server = server.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                server.backend.close_if_idle().await;
            }
        })
    };

    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("could not listen on {listen}"))?;
    log::info!("deadlock-bot listening on http://{listen}");
    axum::serve(listener, router(server.clone()))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    idle_closer.abort();
    if let Some(task) = feeds_task {
        task.abort();
    }
    server.backend.shutdown().await;
    log::info!("stopped");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt as _;
    use tower::ServiceExt as _;

    use super::*;

    /// Counts calls and answers from a script.
    #[derive(Default)]
    struct Fake {
        active_calls: AtomicUsize,
        result_calls: AtomicUsize,
        spectate_calls: AtomicUsize,
        results: std::sync::Mutex<VecDeque<Result<Value, CallError>>>,
        actives: std::sync::Mutex<VecDeque<Result<Value, CallError>>>,
        spectates: std::sync::Mutex<VecDeque<Result<Value, CallError>>>,
    }

    impl Backend for Fake {
        async fn active(&self) -> Result<Value, CallError> {
            self.active_calls.fetch_add(1, Ordering::SeqCst);
            self.actives
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(json!([{ "match_id": 1 }])))
        }
        async fn result(&self, match_id: u64) -> Result<Value, CallError> {
            self.result_calls.fetch_add(1, Ordering::SeqCst);
            self.results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(json!({ "match_id": match_id, "winning_team": 1 })))
        }
        async fn spectate(&self, match_id: u64) -> Result<Value, CallError> {
            self.spectate_calls.fetch_add(1, Ordering::SeqCst);
            self.spectates.lock().unwrap().pop_front().unwrap_or_else(|| {
                Ok(json!({ "match_id": match_id, "broadcast_url": "http://example.test/tv/1" }))
            })
        }
        async fn status(&self) -> Value {
            json!({ "connected": false })
        }
        async fn close_if_idle(&self) {}
        async fn shutdown(&self) {}
    }

    fn server(limits: Limits, token: Option<&str>) -> (Arc<Server<Fake>>, PathBuf) {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "deadlock-bot-server-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let server = Server::new(Fake::default(), limits, dir.clone(), token.map(str::to_owned));
        (Arc::new(server), dir)
    }

    fn strict() -> Limits {
        Limits {
            active: Duration::from_secs(3600),
            result: Duration::from_secs(3600),
            spectate: Duration::from_secs(3600),
            not_ready: Duration::from_secs(3600),
            spectate_ttl: Duration::from_secs(3600),
            stale_active: Duration::from_secs(3600),
            rate_limited_pause: Duration::from_secs(3600),
        }
    }

    fn relaxed() -> Limits {
        Limits {
            active: Duration::ZERO,
            result: Duration::ZERO,
            not_ready: Duration::ZERO,
            ..strict()
        }
    }

    async fn get(server: &Arc<Server<Fake>>, uri: &str, token: Option<&str>) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::get(uri);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = router(server.clone())
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, body)
    }

    #[tokio::test]
    async fn live_list_is_cached_between_waits() {
        let (s, dir) = server(strict(), None);
        let (status, _, body) = get(&s, "/v1/matches/active", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["match_id"], 1);
        let (status, headers, _) = get(&s, "/v1/matches/active", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers.contains_key(header::AGE));
        assert_eq!(s.backend.active_calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn old_live_list_is_served_when_steam_fails() {
        let (s, dir) = server(relaxed(), None);
        get(&s, "/v1/matches/active", None).await;
        s.backend.actives.lock().unwrap().push_back(Err(CallError::Failed("boom".into())));
        let (status, _, body) = get(&s, "/v1/matches/active", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["match_id"], 1);
        assert_eq!(s.backend.active_calls.load(Ordering::SeqCst), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn player_lookup_is_refused() {
        let (s, dir) = server(strict(), None);
        let (status, _, _) = get(&s, "/v1/matches/active?account_id=7", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(s.backend.active_calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn result_has_deadlock_api_shape_and_is_cached() {
        let (s, dir) = server(strict(), None);
        let (status, _, body) = get(&s, "/v1/matches/42/metadata", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["match_info"]["winning_team"], 1);
        let (status, _, _) = get(&s, "/v1/matches/42/metadata", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(s.backend.result_calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn second_result_within_the_wait_is_429() {
        let (s, dir) = server(strict(), None);
        get(&s, "/v1/matches/42/metadata", None).await;
        let (status, headers, _) = get(&s, "/v1/matches/43/metadata", None).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        let retry: u64 = headers[header::RETRY_AFTER].to_str().unwrap().parse().unwrap();
        assert!(retry > 3500, "Retry-After was {retry}");
        assert_eq!(s.backend.result_calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn unfinished_match_is_404_and_not_asked_again_at_once() {
        let limits = Limits {
            result: Duration::ZERO,
            ..strict()
        };
        let (s, dir) = server(limits, None);
        s.backend
            .results
            .lock()
            .unwrap()
            .push_back(Err(CallError::Answer(GcAnswer::NotReady("in flight".into()))));
        let (status, _, _) = get(&s, "/v1/matches/42/metadata", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, headers, _) = get(&s, "/v1/matches/42/metadata", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(headers.contains_key(header::RETRY_AFTER));
        assert_eq!(s.backend.result_calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn busy_and_logged_out_are_503_with_retry_after() {
        let (s, dir) = server(relaxed(), None);
        s.backend
            .results
            .lock()
            .unwrap()
            .push_back(Err(CallError::Answer(GcAnswer::Busy("rate limited".into()))));
        let (status, headers, _) = get(&s, "/v1/matches/1/metadata", None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(headers[header::RETRY_AFTER], "60");

        s.backend
            .results
            .lock()
            .unwrap()
            .push_back(Err(CallError::NotLoggedIn("run login".into())));
        let (status, headers, _) = get(&s, "/v1/matches/2/metadata", None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(headers[header::RETRY_AFTER], "300");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn broadcast_url_is_cached() {
        let (s, dir) = server(strict(), None);
        let (status, _, body) = get(&s, "/v1/matches/9/live/url", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["broadcast_url"], "http://example.test/tv/1");
        get(&s, "/v1/matches/9/live/url", None).await;
        assert_eq!(s.backend.spectate_calls.load(Ordering::SeqCst), 1);
        let (status, _, _) = get(&s, "/v1/matches/10/live/url", None).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_cached_broadcast_is_read_without_spending_the_wait() {
        let (s, dir) = server(strict(), None);
        assert!(s.spectated(9).is_none());
        s.spectate(9).await.unwrap();
        assert_eq!(s.spectated(9).unwrap()["broadcast_url"], "http://example.test/tv/1");
        assert!(s.spectated(10).is_none());
        assert_eq!(s.backend.spectate_calls.load(Ordering::SeqCst), 1);
        assert!(matches!(s.spectate(10).await, Err(Spectate::TooSoon(_))));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_rate_limited_spectate_pauses_spectating() {
        let limits = Limits { spectate: Duration::ZERO, rate_limited_pause: Duration::from_secs(1800), ..strict() };
        let (s, dir) = server(limits, None);
        let refusal = GcAnswer::RateLimited("Steam would not spectate match 9: k_eRateLimited".into());
        s.backend.spectates.lock().unwrap().push_back(Err(CallError::Answer(refusal)));
        assert!(matches!(
            s.spectate(9).await,
            Err(Spectate::Failed(CallError::Answer(GcAnswer::RateLimited(_))))
        ));
        // No spectate wait at all here, yet nothing goes to Steam during the pause.
        let Err(Spectate::TooSoon(left)) = s.spectate(10).await else { panic!("expected the pause") };
        assert!((1790..=1800).contains(&left), "{left}");
        assert_eq!(s.backend.spectate_calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_busy_coordinator_does_not_pause_spectating() {
        let limits = Limits { spectate: Duration::ZERO, ..strict() };
        let (s, dir) = server(limits, None);
        let busy = GcAnswer::Busy("Steam would not spectate match 9: k_eTooBusy".into());
        s.backend.spectates.lock().unwrap().push_back(Err(CallError::Answer(busy)));
        assert!(matches!(s.spectate(9).await, Err(Spectate::Failed(_))));
        assert!(s.spectate(10).await.is_ok());
        assert_eq!(s.backend.spectate_calls.load(Ordering::SeqCst), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn token_is_required_when_set() {
        let (s, dir) = server(strict(), Some("secret"));
        let (status, _, _) = get(&s, "/v1/matches/active", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = get(&s, "/v1/matches/active", Some("wrong")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = get(&s, "/v1/matches/active", Some("secret")).await;
        assert_eq!(status, StatusCode::OK);
        // Health needs no token.
        let (status, _, body) = get(&s, "/healthz", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["source"], "deadlock-bot");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
