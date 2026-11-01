//! The three match requests: live matches, spectate (broadcast URL) and the official result.

use std::io::Read as _;
use std::path::Path;

use anyhow::{Context, Result, bail};
use prost::Message;
use serde_json::{Value, json};
use valveprotos::deadlock::c_msg_client_to_gc_get_match_meta_data_response::EResult as MetaDataResult;
use valveprotos::deadlock::c_msg_client_to_gc_spectate_user_response::EResponse as SpectateResult;
use valveprotos::deadlock::{
    CMsgClientToGcGetActiveMatches, CMsgClientToGcGetActiveMatchesResponse,
    CMsgClientToGcGetMatchMetaData, CMsgClientToGcGetMatchMetaDataResponse,
    CMsgClientToGcSpectateLobby, CMsgClientToGcSpectateLobbyResponse, CMsgDevMatchInfo,
    CMsgMatchMetaData, CMsgMatchMetaDataContents, CMsgMatchMetaDataContentsPatched,
    ECitadelRegionMode, EgcCitadelClientMessages,
};
use valveprotos::gcsdk::EgcPlatform;

use crate::gc::{DEADLOCK_APP_ID, GcSession};

/// The game coordinator answered, but not with what was asked for. The Steam session is fine,
/// so `serve` keeps it open.
#[derive(Debug)]
pub enum GcAnswer {
    /// The match is still being played or processed, or the GC does not know it.
    NotReady(String),
    /// The GC is rate limiting this account or is too busy right now.
    Busy(String),
    /// The GC refused for another reason.
    Refused(String),
}

impl std::fmt::Display for GcAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotReady(m) | Self::Busy(m) | Self::Refused(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for GcAnswer {}

/// Live matches from the in-game Watch tab (Valve returns at most the top 200).
pub async fn active(gc: &GcSession) -> Result<Value> {
    let raw = gc
        .call_raw(
            EgcCitadelClientMessages::KEMsgClientToGcGetActiveMatches,
            CMsgClientToGcGetActiveMatches::default().encode_to_vec(),
        )
        .await?;
    let reply = decode_active(&raw)?;
    Ok(Value::Array(
        reply.active_matches.iter().map(match_json).collect(),
    ))
}

/// deadlock-api decodes this reply by skipping a 7-byte header and Snappy-decompressing the
/// rest. A plain protobuf reply is accepted too, in case Valve stops compressing it.
fn decode_active(raw: &[u8]) -> Result<CMsgClientToGcGetActiveMatchesResponse> {
    if let Some(body) = raw.get(7..)
        && let Ok(buf) = snap::raw::Decoder::new().decompress_vec(body)
        && let Ok(reply) = CMsgClientToGcGetActiveMatchesResponse::decode(buf.as_slice())
    {
        return Ok(reply);
    }
    CMsgClientToGcGetActiveMatchesResponse::decode(raw)
        .context("could not decode the live match list")
}

/// Same field names as deadlock-api's `GET /v1/matches/active`, without its `*_parsed` fields,
/// so the Watcher can read either source.
fn match_json(m: &CMsgDevMatchInfo) -> Value {
    json!({
        "match_id": m.match_id,
        "lobby_id": m.lobby_id,
        "start_time": m.start_time,
        "duration_s": m.duration_s,
        "winning_team": m.winning_team,
        "players": m.players.iter().map(|p| json!({
            "account_id": p.account_id,
            "team": p.team,
            "hero_id": p.hero_id,
            "abandoned": p.abandoned,
        })).collect::<Vec<_>>(),
        "net_worth_team_0": m.net_worth_team_0,
        "net_worth_team_1": m.net_worth_team_1,
        "objectives_mask_team0": m.objectives_mask_team0,
        "objectives_mask_team1": m.objectives_mask_team1,
        "team_stats": m.team_stats.iter().map(|t| json!({
            "team": t.team,
            "net_worth": t.net_worth,
            "objectives_mask": t.objectives_mask,
            "brawl_score": t.brawl_score,
        })).collect::<Vec<_>>(),
        "spectators": m.spectators,
        "open_spectator_slots": m.open_spectator_slots,
        "match_mode": m.match_mode,
        "game_mode": m.game_mode,
        "game_mode_version": m.game_mode_version,
        "match_score": m.match_score,
        "region_mode": m.region_mode,
        "region_mode_parsed": m.region_mode.and_then(region_name),
        "compat_version": m.compat_version,
        "low_pri_pool": m.low_pri_pool,
    })
}

/// deadlock-api's `region_mode_parsed`: the region name in lower case ("europe", "row", ...).
fn region_name(code: i32) -> Option<String> {
    let region = ECitadelRegionMode::try_from(code).ok()?;
    Some(
        region
            .as_str_name()
            .trim_start_matches("k_ECitadelRegionMode_")
            .to_lowercase(),
    )
}

/// Asks the GC to spectate a live match and returns its broadcast URL. Any broadcast parser
/// (or deadlock-api's `/v1/matches/demo/live/query?broadcast_url=`) can read that URL.
pub async fn spectate(
    gc: &GcSession,
    http: &reqwest::Client,
    match_id: u64,
    client_version: Option<u32>,
) -> Result<Value> {
    let client_version = match client_version {
        Some(version) => version,
        None => current_client_version(http).await?,
    };
    let request = CMsgClientToGcSpectateLobby {
        match_id: Some(match_id),
        client_version: Some(client_version),
        client_platform: Some(EgcPlatform::KEGcPlatformPc as i32),
        ..Default::default()
    };
    let reply: CMsgClientToGcSpectateLobbyResponse = gc
        .call(
            EgcCitadelClientMessages::KEMsgClientToGcSpectateLobby,
            &request,
        )
        .await?;
    let result = reply.result.context("the spectate reply was empty")?;
    let code = result.result.unwrap_or_default();
    match (SpectateResult::try_from(code), result.client_broadcast_url) {
        (Ok(SpectateResult::KESuccess), Some(broadcast_url)) => Ok(json!({
            "match_id": match_id,
            "broadcast_url": broadcast_url,
            "lobby_id": result.lobby_id,
        })),
        (Ok(other), _) => {
            let message = format!(
                "Steam would not spectate match {match_id}: {}",
                other.as_str_name()
            );
            Err(match other {
                SpectateResult::KETooBusy | SpectateResult::KERateLimited => {
                    GcAnswer::Busy(message)
                }
                SpectateResult::KENotInGame => GcAnswer::NotReady(message),
                _ => GcAnswer::Refused(message),
            }
            .into())
        }
        (Err(_), _) => Err(GcAnswer::Refused(format!(
            "Steam would not spectate match {match_id}: unknown code {code}"
        ))
        .into()),
    }
}

/// The game build the GC expects in spectate requests. Same sources as deadlock-api.
async fn current_client_version(http: &reqwest::Client) -> Result<u32> {
    #[derive(serde::Deserialize)]
    struct Reply {
        result: ReplyResult,
    }
    #[derive(serde::Deserialize)]
    struct ReplyResult {
        success: bool,
        min_allowed_version: Option<u32>,
    }

    let from_steam = async {
        let reply: Reply = http
            .get(format!(
                "https://api.steampowered.com/IGCVersion_{DEADLOCK_APP_ID}/GetClientVersion/v1/"
            ))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        anyhow::ensure!(reply.result.success, "Steam returned success=false");
        reply
            .result
            .min_allowed_version
            .context("no min_allowed_version")
    };
    match from_steam.await {
        Ok(version) => return Ok(version),
        Err(e) => log::debug!("client version from Steam failed: {e:#}"),
    }

    let steam_inf = http
        .get("https://raw.githubusercontent.com/SteamDatabase/GameTracking-Deadlock/refs/heads/master/game/citadel/steam.inf")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    parse_steam_inf(&steam_inf)
        .context("could not find the current Deadlock client version; pass --client-version")
}

fn parse_steam_inf(text: &str) -> Option<u32> {
    text.lines()
        .find_map(|line| line.trim().strip_prefix("ClientVersion="))
        .and_then(|v| v.trim().parse().ok())
}

/// The official post-match report: who won, how long it took and each player's stats.
pub async fn result(
    gc: &GcSession,
    http: &reqwest::Client,
    match_id: u64,
    save_to: Option<&Path>,
) -> Result<Value> {
    let request = CMsgClientToGcGetMatchMetaData {
        match_id: Some(match_id),
        ..Default::default()
    };
    let reply: CMsgClientToGcGetMatchMetaDataResponse = gc
        .call(
            EgcCitadelClientMessages::KEMsgClientToGcGetMatchMetaData,
            &request,
        )
        .await?;
    let code = reply.result.unwrap_or_default();
    match MetaDataResult::try_from(code) {
        Ok(MetaDataResult::KEResultSuccess) => {}
        Ok(MetaDataResult::KEResultMatchInFlight) => {
            return Err(GcAnswer::NotReady(format!(
                "match {match_id} is still being played or processed; try again later"
            ))
            .into());
        }
        Ok(MetaDataResult::KEResultInvalidMatch) => {
            return Err(
                GcAnswer::NotReady(format!("Steam does not know match {match_id}")).into(),
            );
        }
        Ok(
            other @ (MetaDataResult::KEResultRateLimited
            | MetaDataResult::KEResultTooBusy
            | MetaDataResult::KEResultTemporarilyDisabled
            | MetaDataResult::KEResultTimeout),
        ) => {
            return Err(GcAnswer::Busy(format!(
                "Steam returned {} for match {match_id}",
                other.as_str_name()
            ))
            .into());
        }
        Ok(other) => {
            return Err(GcAnswer::Refused(format!(
                "Steam returned {} for match {match_id}",
                other.as_str_name()
            ))
            .into());
        }
        Err(_) => {
            return Err(GcAnswer::Refused(format!(
                "Steam returned unknown code {code} for match {match_id}"
            ))
            .into());
        }
    }
    let (Some(cluster), Some(salt)) = (reply.replay_group_id, reply.metadata_salt) else {
        bail!("Steam did not say where the report for match {match_id} is stored");
    };

    let url = metadata_url(cluster, match_id, salt);
    let bytes = http
        .get(&url)
        .send()
        .await?
        .error_for_status()
        .with_context(|| format!("could not download {url}"))?
        .bytes()
        .await?;
    if let Some(path) = save_to {
        std::fs::write(path, &bytes)
            .with_context(|| format!("could not write {}", path.display()))?;
    }

    let contents = parse_metadata(&bytes)?;
    Ok(result_json(match_id, &url, &contents))
}

fn metadata_url(cluster: u32, match_id: u64, salt: u32) -> String {
    format!("http://replay{cluster}.valve.net/{DEADLOCK_APP_ID}/{match_id}_{salt}.meta.bz2")
}

/// The file is named `.meta.bz2`, but newer matches are zstd-compressed, so check the bytes.
fn decompress(raw: &[u8]) -> Result<Vec<u8>> {
    const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
    let mut out = Vec::new();
    if raw.starts_with(&ZSTD_MAGIC) {
        zstd::stream::read::Decoder::new(raw)?
            .read_to_end(&mut out)
            .context("could not unpack the zstd report")?;
    } else {
        bzip2::read::BzDecoder::new(raw)
            .read_to_end(&mut out)
            .context("could not unpack the bzip2 report")?;
    }
    Ok(out)
}

fn parse_metadata(raw: &[u8]) -> Result<CMsgMatchMetaDataContents> {
    let buf = decompress(raw)?;
    let details = CMsgMatchMetaData::decode(buf.as_slice())
        .context("could not decode the match report")?
        .match_details
        .context("the match report has no details")?;
    if let Ok(contents) = CMsgMatchMetaDataContents::decode(details.as_slice()) {
        return Ok(contents);
    }
    // Some reports only decode with deadlock-api's patched message, as their API does.
    let patched = CMsgMatchMetaDataContentsPatched::decode(details.as_slice())
        .context("could not decode the match details")?;
    CMsgMatchMetaDataContents::decode(patched.encode_to_vec().as_slice())
        .context("could not decode the patched match details")
}

fn result_json(match_id: u64, url: &str, contents: &CMsgMatchMetaDataContents) -> Value {
    let Some(info) = &contents.match_info else {
        return json!({ "match_id": match_id, "metadata_url": url, "match_info": null });
    };
    json!({
        "match_id": info.match_id.unwrap_or(match_id),
        "metadata_url": url,
        "start_time": info.start_time,
        "duration_s": info.duration_s,
        "winning_team": info.winning_team,
        "match_outcome": info.match_outcome,
        "not_scored": info.not_scored,
        "game_mode": info.game_mode,
        "match_mode": info.match_mode,
        "players": info.players.iter().map(|p| json!({
            "account_id": p.account_id,
            "player_slot": p.player_slot,
            "team": p.team,
            "hero_id": p.hero_id,
            "kills": p.kills,
            "deaths": p.deaths,
            "assists": p.assists,
            "net_worth": p.net_worth,
            "abandon_match_time_s": p.abandon_match_time_s,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use valveprotos::deadlock::c_msg_dev_match_info::MatchPlayer;
    use valveprotos::deadlock::c_msg_match_meta_data_contents::{MatchInfo, Players};

    use super::*;

    fn sample_reply() -> CMsgClientToGcGetActiveMatchesResponse {
        CMsgClientToGcGetActiveMatchesResponse {
            active_matches: vec![CMsgDevMatchInfo {
                match_id: Some(125_169_778),
                lobby_id: Some(102_135_642_516_701_796),
                net_worth_team_0: Some(52_000),
                spectators: Some(5),
                players: vec![MatchPlayer {
                    account_id: Some(184_601_350),
                    team: Some(1),
                    hero_id: Some(86),
                    abandoned: None,
                }],
                ..Default::default()
            }],
        }
    }

    #[test]
    fn decodes_compressed_active_matches() {
        let body = sample_reply().encode_to_vec();
        let mut raw = vec![0u8; 7];
        raw.extend(snap::raw::Encoder::new().compress_vec(&body).unwrap());
        assert_eq!(decode_active(&raw).unwrap(), sample_reply());
    }

    #[test]
    fn decodes_plain_active_matches() {
        let raw = sample_reply().encode_to_vec();
        assert_eq!(decode_active(&raw).unwrap(), sample_reply());
    }

    #[test]
    fn match_json_uses_deadlock_api_field_names() {
        let value = match_json(&sample_reply().active_matches[0]);
        assert_eq!(value["match_id"], 125_169_778);
        assert_eq!(value["lobby_id"], 102_135_642_516_701_796_u64);
        assert_eq!(value["net_worth_team_0"], 52_000);
        assert_eq!(value["players"][0]["hero_id"], 86);
        assert_eq!(value["players"][0]["team"], 1);
        assert!(value["duration_s"].is_null());
    }

    #[test]
    fn region_names_match_deadlock_api() {
        assert_eq!(region_name(1).as_deref(), Some("europe"));
        assert_eq!(region_name(0).as_deref(), Some("row"));
        assert_eq!(region_name(999), None);
        let mut m = sample_reply().active_matches[0].clone();
        m.region_mode = Some(1);
        assert_eq!(match_json(&m)["region_mode_parsed"], "europe");
    }

    #[test]
    fn reads_client_version_from_steam_inf() {
        let text = "ClientVersion=6819\nServerVersion=6819\nPatchVersion=1.0\n";
        assert_eq!(parse_steam_inf(text), Some(6819));
        assert_eq!(parse_steam_inf("nothing here"), None);
    }

    #[test]
    fn builds_metadata_url() {
        assert_eq!(
            metadata_url(3, 7, 11),
            "http://replay3.valve.net/1422450/7_11.meta.bz2"
        );
    }

    fn sample_report() -> Vec<u8> {
        let contents = CMsgMatchMetaDataContents {
            match_info: Some(MatchInfo {
                match_id: Some(42),
                duration_s: Some(1_800),
                winning_team: Some(1),
                players: vec![Players {
                    account_id: Some(7),
                    hero_id: Some(15),
                    kills: Some(4),
                    deaths: Some(1),
                    assists: Some(7),
                    ..Default::default()
                }],
                ..Default::default()
            }),
        };
        CMsgMatchMetaData {
            match_details: Some(contents.encode_to_vec()),
            match_id: Some(42),
            ..Default::default()
        }
        .encode_to_vec()
    }

    fn check_report(contents: &CMsgMatchMetaDataContents) {
        let value = result_json(42, "url", contents);
        assert_eq!(value["winning_team"], 1);
        assert_eq!(value["duration_s"], 1_800);
        assert_eq!(value["players"][0]["kills"], 4);
        assert_eq!(value["players"][0]["hero_id"], 15);
    }

    #[test]
    fn parses_bzip2_report() {
        let mut enc = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        enc.write_all(&sample_report()).unwrap();
        check_report(&parse_metadata(&enc.finish().unwrap()).unwrap());
    }

    #[test]
    fn parses_zstd_report() {
        let raw = zstd::encode_all(sample_report().as_slice(), 0).unwrap();
        check_report(&parse_metadata(&raw).unwrap());
    }
}
