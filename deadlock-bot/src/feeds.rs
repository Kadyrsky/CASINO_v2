//! Feed manager for `serve`: follows the broadcasts of the matches the site needs and publishes their map frames
//! (see [`crate::live`]) through Redis.
//!
//! Which matches: the watcher's tracked matches first (their live state also drives the odds), then any match a
//! viewer has open on the site, up to `max_feeds`. Broadcast URLs come from deadlock-api's public list
//! (`/v1/matches/live/urls`, free) and, when a match isn't there, from spectating it with the bot (one per 5 min).
//!
//! Redis, shared with the watcher and the core:
//! - reads `watcher:tracked` (JSON array of match ids) and the sorted set `live:wanted` (member = match id,
//!   score = unix time until which a viewer wants it; the core keeps it fresh),
//! - writes `live:frame:{match_id}` (the latest frame, 30 s TTL) and publishes every frame on `naebka:live-frames`,
//! - writes `live:feeds` (what is being followed, 30 s TTL) for the admin page.

use core::time::Duration;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::live::{self, Frame};
use crate::server::{Server, Spectate, SteamBackend};

pub const FRAMES_CHANNEL: &str = "naebka:live-frames";
const FRAME_TTL_S: u64 = 30;
/// A broadcast that ended (or never started) is not tried again for this long.
const AFTER_END: Duration = Duration::from_secs(10 * 60);
const AFTER_ERROR: Duration = Duration::from_secs(45);
/// After a feed that was working stops (Valve's relay sometimes misses a few fragments), or after a stale link.
const QUICK_RETRY: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct Config {
    pub redis_url: String,
    pub max_feeds: usize,
    /// Sample every this many ticks (64 per second): 32 gives 2 frames per second.
    pub every_ticks: i32,
    pub deadlock_api: String,
}

struct Running {
    stop: Arc<AtomicBool>,
    frames: Arc<AtomicU64>,
    started: Instant,
    url: String,
    from_public_list: bool,
}

/// When to try a match again after its feed stopped, and whether to spectate it instead of using deadlock-api's
/// public link. A feed that delivered frames may have stopped on a relay hiccup: try again soon (if the match is
/// over, that attempt gets nothing). A public link that gives nothing is often stale: spectate the match ourselves.
fn after_stop(frames: u64, from_public_list: bool) -> (Duration, bool) {
    match (frames, from_public_list) {
        (1.., _) => (QUICK_RETRY, false),
        (0, true) => (QUICK_RETRY, true),
        (0, false) => (AFTER_END, false),
    }
}

fn unix_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// Runs until the process stops. Redis being down only pauses it.
pub async fn run(cfg: Config, server: Arc<Server<SteamBackend>>, http: reqwest::Client) {
    loop {
        match run_once(&cfg, &server, &http).await {
            Ok(()) => return,
            Err(e) => {
                log::warn!("live feeds paused: {e:#}");
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    }
}

async fn run_once(cfg: &Config, server: &Arc<Server<SteamBackend>>, http: &reqwest::Client) -> Result<()> {
    log::debug!("connecting to Redis for the live feeds");
    let client = redis::Client::open(cfg.redis_url.as_str()).context("bad REDIS_URL")?;
    let mut con = tokio::time::timeout(Duration::from_secs(10), ConnectionManager::new(client))
        .await
        .context("Redis did not answer within 10 s")?
        .context("could not connect to Redis")?;
    log::info!("live feeds on (up to {} matches)", cfg.max_feeds);

    let (frames_tx, mut frames_rx) = mpsc::channel::<Vec<Frame>>(256);
    let mut publisher = con.clone();
    tokio::spawn(async move {
        while let Some(frames) = frames_rx.recv().await {
            for frame in frames {
                if let Err(e) = publish(&mut publisher, &frame).await {
                    log::debug!("could not publish a frame: {e}");
                }
            }
        }
    });

    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<(u64, Result<(), String>)>();
    let mut running: HashMap<u64, Running> = HashMap::new();
    let mut not_before: HashMap<u64, Instant> = HashMap::new();
    let mut spectate_instead: HashSet<u64> = HashSet::new();
    let mut urls = PublicUrls::default();

    loop {
        while let Ok((id, result)) = done_rx.try_recv() {
            if let Some(r) = running.remove(&id) {
                let frames = r.frames.load(Ordering::Relaxed);
                match &result {
                    Ok(()) => log::info!("feed {id} ended after {frames} frames"),
                    Err(e) => log::warn!("feed {id} failed after {frames} frames: {e}"),
                }
                let (wait, spectate) = after_stop(frames, r.from_public_list);
                not_before.insert(id, Instant::now() + wait);
                if spectate {
                    spectate_instead.insert(id);
                }
            }
        }
        not_before.retain(|_, t| *t > Instant::now());
        spectate_instead.retain(|id| not_before.contains_key(id) || running.contains_key(id) || urls.by_match.contains_key(id));

        let wanted = wanted(&mut con, cfg.max_feeds).await?;
        for (id, r) in &running {
            if !wanted.contains(id) {
                r.stop.store(true, Ordering::Relaxed);
            }
        }
        for &id in &wanted {
            if running.len() >= cfg.max_feeds {
                break;
            }
            if running.contains_key(&id) || not_before.contains_key(&id) {
                continue;
            }
            let allow_public = !spectate_instead.contains(&id);
            match broadcast_url(id, &mut urls, http, &cfg.deadlock_api, server, allow_public).await {
                Ok((url, from_public_list)) => {
                    log::info!("following match {id}: {url}");
                    let mut feed = start(id, url, cfg.every_ticks, frames_tx.clone(), done_tx.clone());
                    feed.from_public_list = from_public_list;
                    running.insert(id, feed);
                }
                Err(why) => {
                    log::debug!("no broadcast for match {id} yet: {why}");
                    not_before.insert(id, Instant::now() + AFTER_ERROR);
                }
            }
        }

        let status = json!({
            "updated_at": unix_now(),
            "max": cfg.max_feeds,
            "feeds": running.iter().map(|(id, r)| json!({
                "match_id": id.to_string(),
                "url": r.url,
                "frames": r.frames.load(Ordering::Relaxed),
                "running_s": r.started.elapsed().as_secs(),
            })).collect::<Vec<_>>(),
        });
        redis::cmd("SET").arg("live:feeds").arg(status.to_string()).arg("EX").arg(FRAME_TTL_S)
            .query_async::<()>(&mut con).await?;
        tokio::time::sleep(TICK).await;
    }
}

/// Tracked matches first, then the ones viewers have open (newest interest first).
async fn wanted(con: &mut ConnectionManager, max: usize) -> Result<Vec<u64>> {
    let tracked: Option<String> = redis::cmd("GET").arg("watcher:tracked").query_async(con).await?;
    let mut out: Vec<u64> = tracked
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
        .collect();
    let now = unix_now();
    redis::cmd("ZREMRANGEBYSCORE").arg("live:wanted").arg("-inf").arg(now).query_async::<()>(con).await?;
    let viewers: Vec<String> = redis::cmd("ZREVRANGEBYSCORE").arg("live:wanted").arg("+inf").arg(now)
        .query_async(con).await?;
    let mut seen: HashSet<u64> = out.iter().copied().collect();
    for id in viewers.iter().filter_map(|s| s.parse::<u64>().ok()) {
        if seen.insert(id) {
            out.push(id);
        }
    }
    out.truncate(max);
    Ok(out)
}

async fn publish(con: &mut ConnectionManager, frame: &Frame) -> Result<()> {
    let mut value = serde_json::to_value(frame)?;
    value["match_id"] = json!(frame.match_id.to_string());
    value["received_at"] = json!(unix_now());
    let text = value.to_string();
    redis::cmd("SET").arg(format!("live:frame:{}", frame.match_id)).arg(&text).arg("EX").arg(FRAME_TTL_S)
        .query_async::<()>(con).await?;
    redis::cmd("PUBLISH").arg(FRAMES_CHANNEL).arg(&text).query_async::<()>(con).await?;
    Ok(())
}

/// Runs one feed on its own thread: haste's parser can't move between threads.
fn start(
    id: u64,
    url: String,
    every_ticks: i32,
    frames_tx: mpsc::Sender<Vec<Frame>>,
    done_tx: mpsc::UnboundedSender<(u64, Result<(), String>)>,
) -> Running {
    let stop = Arc::new(AtomicBool::new(false));
    let frames = Arc::new(AtomicU64::new(0));
    let (stop_in, frames_in, url_in) = (stop.clone(), frames.clone(), url.clone());
    let spawned = std::thread::Builder::new().name(format!("feed-{id}")).spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(anyhow::Error::from)
            .and_then(|rt| {
                rt.block_on(live::follow(&url_in, id, every_ticks, |batch| {
                    frames_in.fetch_add(batch.len() as u64, Ordering::Relaxed);
                    // Never block the parser: a full queue drops this batch, the next one follows in ~3 s.
                    let _ = frames_tx.try_send(batch);
                    !stop_in.load(Ordering::Relaxed)
                }))
            });
        let _ = done_tx.send((id, result.map_err(|e| format!("{e:#}"))));
    });
    if let Err(e) = spawned {
        log::warn!("could not start a thread for match {id}: {e}");
    }
    Running { stop, frames, started: Instant::now(), url, from_public_list: false }
}

/// deadlock-api's list of broadcast URLs that someone already spectated, refreshed at most every 30 s.
#[derive(Default)]
struct PublicUrls {
    fetched: Option<Instant>,
    by_match: HashMap<u64, String>,
}

async fn broadcast_url(
    id: u64,
    urls: &mut PublicUrls,
    http: &reqwest::Client,
    api: &str,
    server: &Server<SteamBackend>,
    allow_public: bool,
) -> Result<(String, bool), String> {
    if urls.fetched.is_none_or(|t| t.elapsed() > Duration::from_secs(30)) {
        urls.fetched = Some(Instant::now());
        match fetch_public_urls(http, api).await {
            Ok(map) => urls.by_match = map,
            Err(e) => log::debug!("deadlock-api live/urls failed: {e:#}"),
        }
    }
    if allow_public && let Some(url) = urls.by_match.get(&id) {
        return Ok((url.clone(), true));
    }
    match server.spectate(id).await {
        Ok(v) => v["broadcast_url"].as_str().map(|u| (u.to_owned(), false)).ok_or_else(|| "no broadcast_url".to_owned()),
        Err(Spectate::TooSoon(wait)) => Err(format!("spectate wait: {wait}s")),
        Err(Spectate::Failed(e)) => Err(format!("{e:?}")),
    }
}

async fn fetch_public_urls(http: &reqwest::Client, api: &str) -> Result<HashMap<u64, String>> {
    let list: Vec<Value> = http
        .get(format!("{}/v1/matches/live/urls", api.trim_end_matches('/')))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(list
        .iter()
        .filter_map(|e| Some((e["match_id"].as_u64()?, e["broadcast_url"].as_str()?.to_owned())))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_feed_that_worked_is_retried_soon() {
        assert_eq!(after_stop(120, true), (QUICK_RETRY, false));
        assert_eq!(after_stop(120, false), (QUICK_RETRY, false));
    }

    #[test]
    fn a_stale_public_link_makes_the_bot_spectate() {
        assert_eq!(after_stop(0, true), (QUICK_RETRY, true));
    }

    #[test]
    fn a_spectated_broadcast_that_gives_nothing_is_over() {
        assert_eq!(after_stop(0, false), (AFTER_END, false));
    }
}
