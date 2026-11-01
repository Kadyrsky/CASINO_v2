//! deadlock-bot: asks Deadlock's game coordinator about matches through a Steam account.
//! Results go to stdout as JSON; messages and errors go to stderr.

mod auth;
mod feeds;
mod gc;
mod guard;
mod live;
mod matches;
mod server;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::Value;

use crate::gc::GcSession;

#[derive(Parser)]
#[command(
    version,
    about = "Asks Deadlock's game coordinator about matches, using your Steam account."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Skip the minimum wait between requests of the same kind.
    #[arg(long, global = true)]
    force: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Log in once with your Steam password and Steam Guard, and save a login token on this computer.
    Login {
        /// Your Steam login name (not the profile name).
        #[arg(long, env = "STEAM_USERNAME")]
        username: String,
    },
    /// Delete the saved login token.
    Logout,
    /// List live matches from the in-game Watch tab (top 200).
    Active,
    /// Get the live broadcast URL of a match that is being played now.
    Spectate {
        match_id: u64,
        /// Deadlock client build number. Looked up automatically when left out.
        #[arg(long)]
        client_version: Option<u32>,
    },
    /// Get the official result of a finished match.
    Result {
        match_id: u64,
        /// Also save Valve's raw report file here.
        #[arg(long)]
        save: Option<PathBuf>,
    },
    /// Print live map frames (JSON lines) from a match's broadcast URL, for testing the live feed.
    Live {
        /// Broadcast URL, e.g. from `spectate` or deadlock-api's /v1/matches/live/urls.
        broadcast_url: String,
        /// Stop after this many seconds.
        #[arg(long, default_value_t = 30)]
        seconds: u64,
    },
    /// Stay logged in and answer HTTP requests with the same JSON as deadlock-api, so the website
    /// can fall back to the bot when deadlock-api says "too many requests".
    Serve {
        /// Address to listen on. Use 0.0.0.0:8090 inside Docker.
        #[arg(long, env = "DEADLOCK_BOT_LISTEN", default_value = "127.0.0.1:8090")]
        listen: SocketAddr,
        /// When set, every request except /healthz needs `Authorization: Bearer <token>`.
        #[arg(long, env = "DEADLOCK_BOT_TOKEN", hide_env_values = true)]
        token: Option<String>,
        /// Close the Steam session after this many minutes without requests.
        #[arg(long, env = "DEADLOCK_BOT_IDLE_MINUTES", default_value_t = 15)]
        idle_minutes: u64,
        /// Redis for the live map feeds (frames for the website). Leave out to run without feeds.
        #[arg(long, env = "REDIS_URL")]
        redis_url: Option<String>,
        /// Most broadcasts followed at once (each uses about one CPU core at 5% and 30 MB).
        #[arg(long, env = "DEADLOCK_BOT_MAX_FEEDS", default_value_t = 12)]
        max_feeds: usize,
        /// Where deadlock-api's public list of broadcast URLs lives.
        #[arg(long, env = "DEADLOCK_API_BASE_URL", default_value = "https://api.deadlock-api.com")]
        deadlock_api: String,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("warn,deadlock_bot=info"),
    )
    .init();
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<()> {
    if let Command::Serve {
        listen,
        token,
        idle_minutes,
        redis_url,
        max_feeds,
        deadlock_api,
    } = cli.command
    {
        let feeds = redis_url.filter(|u| !u.is_empty()).map(|redis_url| feeds::Config {
            redis_url,
            max_feeds,
            every_ticks: 32,
            deadlock_api,
        });
        return server::serve(listen, token, Duration::from_secs(idle_minutes.max(1) * 60), feeds).await;
    }
    if let Command::Live { broadcast_url, seconds } = &cli.command {
        let match_id = live::match_id_from_url(broadcast_url).unwrap_or_default();
        let feed = live::follow(broadcast_url, match_id, 32, |frames| {
            for f in frames {
                println!("{}", serde_json::to_string(&f).unwrap_or_default());
            }
            true
        });
        return match tokio::time::timeout(Duration::from_secs(*seconds), feed).await {
            Ok(result) => result,
            Err(_) => Ok(()), // time is up
        };
    }

    let http = reqwest::Client::builder()
        .user_agent(concat!("naebka-deadlock-bot/", env!("CARGO_PKG_VERSION")))
        .build()?;

    match cli.command {
        Command::Login { username } => {
            auth::login(&username).await?;
            eprintln!(
                "Logged in. The login token is saved in {} and is as powerful as your \
                 password: don't share or commit it.",
                auth::state_dir()?.display()
            );
        }
        Command::Logout => {
            if auth::logout()? {
                eprintln!("Deleted the saved login.");
            } else {
                eprintln!("There was no saved login.");
            }
        }
        Command::Active => {
            let ticket = guard::check("active", guard::ACTIVE_GAP, cli.force)?;
            let gc = GcSession::start().await?;
            let out = match ticket.record() {
                Ok(()) => matches::active(&gc).await,
                Err(e) => Err(e),
            };
            gc.close().await;
            print_json(&out?)?;
        }
        Command::Spectate {
            match_id,
            client_version,
        } => {
            let ticket = guard::check("spectate", guard::SPECTATE_GAP, cli.force)?;
            let gc = GcSession::start().await?;
            let out = match ticket.record() {
                Ok(()) => matches::spectate(&gc, &http, match_id, client_version).await,
                Err(e) => Err(e),
            };
            gc.close().await;
            print_json(&out?)?;
        }
        Command::Result { match_id, save } => {
            let ticket = guard::check("result", guard::RESULT_GAP, cli.force)?;
            let gc = GcSession::start().await?;
            let out = match ticket.record() {
                Ok(()) => matches::result(&gc, &http, match_id, save.as_deref()).await,
                Err(e) => Err(e),
            };
            gc.close().await;
            print_json(&out?)?;
        }
        Command::Serve { .. } | Command::Live { .. } => unreachable!("handled above"),
    }
    Ok(())
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
