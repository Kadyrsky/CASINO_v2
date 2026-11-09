//! A session with Deadlock's game coordinator (GC), the Valve server the game client talks to.
//! The handshake follows deadlock-api's `deadlock-api-ingest` tool.

use core::time::Duration;

use anyhow::{Context, Result};
use prost::Message;
use steam_vent::proto::MsgKind;
use steam_vent::proto::enums_clientserver::EMsg;
use steam_vent::proto::steammessages_clientserver::CMsgClientGamesPlayed;
use steam_vent::proto::steammessages_clientserver_login::CMsgClientLoggedOff;
use steam_vent::{Connection, ConnectionTrait, GameCoordinator, UntypedMessage};
use tokio::time::{sleep, timeout};
use valveprotos::deadlock::EgcCitadelClientMessages;

pub const DEADLOCK_APP_ID: u32 = 1422450;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

pub struct GcSession {
    conn: Connection,
    gc: GameCoordinator,
}

impl GcSession {
    /// Logs in with the saved token and completes the GC handshake.
    pub async fn start() -> Result<Self> {
        let conn = crate::auth::connect().await?;
        log::debug!("logged in to Steam; starting the game coordinator handshake");

        // If Steam logs the account off during the handshake, it says why.
        let logged_off = conn.one::<CMsgClientLoggedOff>();

        // Reports Deadlock as running (the GC only talks to accounts that are "in" the game),
        // then sends the standard GC hello every 5 seconds until the GC answers with a welcome.
        let gc = match timeout(
            HANDSHAKE_TIMEOUT,
            GameCoordinator::new(&conn, DEADLOCK_APP_ID),
        )
        .await
        {
            Ok(Ok(gc)) => gc,
            Ok(Err(e)) => {
                let why = timeout(Duration::from_millis(500), logged_off).await;
                stop_playing(&conn).await;
                if let Ok(Ok(off)) = why {
                    return Err(e).context(logged_off_reason(off.eresult()));
                }
                return Err(e).context("the game coordinator handshake failed");
            }
            Err(_) => {
                stop_playing(&conn).await;
                anyhow::bail!(
                    "Deadlock's game coordinator did not answer within {HANDSHAKE_TIMEOUT:?}. \
                     Does this account have access to Deadlock?"
                );
            }
        };
        log::debug!("game coordinator handshake done");
        Ok(Self { conn, gc })
    }

    /// Sends one request to the GC and returns the raw reply body.
    pub async fn call_raw(&self, kind: EgcCitadelClientMessages, body: Vec<u8>) -> Result<Vec<u8>> {
        let reply = timeout(
            CALL_TIMEOUT,
            self.gc
                .job_untyped(UntypedMessage(body), MsgKind(kind as i32), true),
        )
        .await
        .with_context(|| format!("no reply to {} within {CALL_TIMEOUT:?}", kind.as_str_name()))?
        .with_context(|| format!("{} failed", kind.as_str_name()))?;
        Ok(reply.data.to_vec())
    }

    /// Sends one request to the GC and decodes the reply.
    pub async fn call<Rsp: Message + Default>(
        &self,
        kind: EgcCitadelClientMessages,
        request: &impl Message,
    ) -> Result<Rsp> {
        let raw = self.call_raw(kind, request.encode_to_vec()).await?;
        Rsp::decode(raw.as_slice())
            .with_context(|| format!("could not decode the reply to {}", kind.as_str_name()))
    }

    /// Ends the session. It reports Deadlock as closed, so a running game client is not told
    /// it is "playing on another computer". It does not log off: that could sign the account
    /// out elsewhere too, and dropping the connection ends this session anyway.
    pub async fn close(self) {
        stop_playing(&self.conn).await;
    }
}

/// What Steam's reason for logging the bot off means (EResult codes from Valve's SDK).
fn logged_off_reason(eresult: i32) -> String {
    let hint = match eresult {
        6 => "the account logged in somewhere else",
        34 => "another session with this account replaced this one",
        48 => "Steam is busy; try again later",
        84 => "too many logins from this address; wait a while",
        _ => "",
    };
    if hint.is_empty() {
        format!("Steam logged the bot off during the game coordinator handshake (EResult {eresult})")
    } else {
        format!("Steam logged the bot off during the game coordinator handshake (EResult {eresult}: {hint})")
    }
}

async fn stop_playing(conn: &Connection) {
    let sent = timeout(
        Duration::from_secs(5),
        conn.send_with_kind(
            CMsgClientGamesPlayed::default(),
            EMsg::k_EMsgClientGamesPlayedWithDataBlob,
        ),
    )
    .await;
    match sent {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::debug!("could not clear the playing state: {e}"),
        Err(_) => log::debug!("clearing the playing state timed out"),
    }
    // Give Steam a moment to receive it before the connection drops.
    sleep(Duration::from_millis(500)).await;
}
