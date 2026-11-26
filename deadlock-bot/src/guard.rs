//! Keeps a minimum gap between requests of the same kind, so the account doesn't look like a
//! bot hammering Valve. deadlock-api's own bots wait even longer (about 10 minutes between live
//! match lists and 29 minutes between spectates per account). Spectating is the one Steam limits
//! first: with a 3-minute gap it answered `k_eRateLimited` to every spectate, so the gap is 5
//! minutes, and `serve` stops spectating for [`SPECTATE_RATE_LIMITED_PAUSE`] whenever Steam says
//! that, since asking again soon only prolongs the limit.
//!
//! The times are kept in a file next to the saved login, so the command-line tool and `serve`
//! share them when they run on the same account.

use core::time::Duration;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

pub const ACTIVE_GAP: Duration = Duration::from_secs(60);
pub const SPECTATE_GAP: Duration = Duration::from_secs(5 * 60);
/// No spectate for this long after Steam answers one with `k_eRateLimited`.
pub const SPECTATE_RATE_LIMITED_PAUSE: Duration = Duration::from_secs(30 * 60);
pub const RESULT_GAP: Duration = Duration::from_secs(60);

/// A request of this kind ran too recently.
#[derive(Debug)]
pub struct TooSoon {
    pub command: String,
    pub elapsed_s: u64,
    pub wait_s: u64,
}

impl std::fmt::Display for TooSoon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "`{}` ran {}s ago; wait {}s more, or pass --force. \
             The wait keeps your Steam account from looking like a bot.",
            self.command, self.elapsed_s, self.wait_s
        )
    }
}

impl std::error::Error for TooSoon {}

/// Permission to send one request, from [`check`]. Call [`Ticket::record`] right before the
/// request goes to Steam, so a failed login does not count as a request.
pub struct Ticket {
    path: PathBuf,
    command: String,
    now: u64,
}

impl Ticket {
    pub fn record(self) -> Result<()> {
        let mut last = read(&self.path);
        last.insert(self.command, self.now);
        std::fs::write(&self.path, serde_json::to_vec_pretty(&last)?)
            .with_context(|| format!("could not write {}", self.path.display()))
    }
}

/// Fails if `command` ran less than `gap` ago, unless `force` is set.
pub fn check(command: &str, gap: Duration, force: bool) -> Result<Ticket> {
    let dir = crate::auth::state_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(check_at(file_in(&dir), command, gap, force, now_secs())?)
}

/// The request log inside a state folder.
pub fn file_in(dir: &Path) -> PathBuf {
    dir.join("last_requests.json")
}

pub fn check_at(
    path: PathBuf,
    command: &str,
    gap: Duration,
    force: bool,
    now: u64,
) -> std::result::Result<Ticket, TooSoon> {
    if !force && let Some(&previous) = read(&path).get(command) {
        let elapsed = now.saturating_sub(previous);
        if elapsed < gap.as_secs() {
            return Err(TooSoon {
                command: command.to_owned(),
                elapsed_s: elapsed,
                wait_s: gap.as_secs() - elapsed,
            });
        }
    }
    Ok(Ticket {
        path,
        command: command.to_owned(),
        now,
    })
}

fn read(path: &Path) -> BTreeMap<String, u64> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_a_quick_repeat_and_allows_it_later() {
        let dir = std::env::temp_dir().join(format!("deadlock-bot-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("last_requests.json");
        let _ = std::fs::remove_file(&path);
        let gap = Duration::from_secs(60);

        let run = |command: &str, force: bool, now: u64| -> Result<()> {
            check_at(path.clone(), command, gap, force, now)?.record()
        };

        run("active", false, 1_000).unwrap();
        assert!(run("active", false, 1_030).is_err());
        // Another command has its own clock.
        run("result", false, 1_030).unwrap();
        // --force skips the wait.
        run("active", true, 1_031).unwrap();
        assert!(run("active", false, 1_060).is_err());
        run("active", false, 1_091).unwrap();
        // A check that never sends anything does not count.
        let _unused = check_at(path.clone(), "spectate", gap, false, 2_000).unwrap();
        run("spectate", false, 2_001).unwrap();

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_how_long_to_wait() {
        let dir = std::env::temp_dir().join(format!("deadlock-bot-wait-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("last_requests.json");
        let _ = std::fs::remove_file(&path);
        let gap = Duration::from_secs(60);

        check_at(path.clone(), "result", gap, false, 100)
            .unwrap()
            .record()
            .unwrap();
        let err = check_at(path.clone(), "result", gap, false, 115)
            .err()
            .expect("too soon");
        assert_eq!(err.wait_s, 45);
        assert_eq!(err.elapsed_s, 15);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
