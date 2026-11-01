//! Live map feed: reads a match's Valve broadcast (the stream the in-game spectator uses, served over HTTP by
//! Valve's relays) with the [haste](https://github.com/blukai/haste) parser and turns it into compact frames:
//! every hero's position, health, level, souls, K/D/A and items, the objectives still standing, and events (kills,
//! purchases, objectives destroyed). The broadcast runs about 20 s behind the real game.
//!
//! haste's parser is single-threaded (`Rc` inside), so each feed runs on its own thread with its own runtime;
//! frames leave through a channel.

use core::time::Duration;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use anyhow::{Context as _, Result};
use haste::broadcast::BroadcastHttp;
use haste::demostream::CmdHeader;
use haste::entities::{DeltaHeader, Entity, ehandle_to_index, fkey_from_path};
use haste::fxhash;
use haste::parser::{Context, Parser, Visitor};
use haste::valveprotos::common::{CnetMsgTick, EDemoCommands, NetMessages};
use haste::valveprotos::deadlock::{CCitadelUserMessageObjectiveMask, CCitadelUserMsgHeroKilled};
use haste::valveprotos::prost::Message;
use serde::Serialize;

use crate::gc::DEADLOCK_APP_ID;

const MSG_HERO_KILLED: u32 = 319;
const MSG_OBJECTIVE_MASK: u32 = 324;
/// Steam IDs are 64-bit; Deadlock account ids are the low 32 bits.
const STEAM_ID_BASE: u64 = 76_561_197_960_265_728;

const CONTROLLER: u64 = fxhash::hash_bytes(b"CCitadelPlayerController");
const PAWN: u64 = fxhash::hash_bytes(b"CCitadelPlayerPawn");
const GAME_RULES: u64 = fxhash::hash_bytes(b"CCitadelGameRulesProxy");

/// Map objectives: serializer name hash → kind shown on the map.
const OBJECTIVES: [(u64, &str); 6] = [
    (fxhash::hash_bytes(b"CNPC_TrooperBoss"), "guardian"),
    (fxhash::hash_bytes(b"CNPC_Boss_Tier2"), "walker"),
    (fxhash::hash_bytes(b"CNPC_BarrackBoss"), "base_guardian"),
    (fxhash::hash_bytes(b"CNPC_Boss_Tier3"), "patron"),
    (fxhash::hash_bytes(b"CNPC_Boss_Tier3Core"), "patron_core"),
    (fxhash::hash_bytes(b"CNPC_MidBoss"), "midboss"),
];

macro_rules! key {
    ($($part:literal),+) => {
        const { fkey_from_path(&[$($part),+]) }
    };
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Player {
    pub slot: i32,
    pub account_id: u32,
    pub hero_id: u32,
    /// 0 = Hidden King (amber), 1 = Archmother (sapphire), like deadlock-api.
    pub team: u8,
    pub level: i32,
    pub net_worth: i32,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub alive: bool,
    /// Seconds until respawn while dead.
    pub respawn_in_s: Option<f32>,
    pub ult_ready: bool,
    pub items: Vec<u32>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub hp: Option<i32>,
    pub max_hp: Option<i32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Objective {
    pub id: i32,
    pub kind: &'static str,
    pub team: Option<u8>,
    pub lane: Option<i32>,
    pub x: f32,
    pub y: f32,
    pub hp: i32,
    pub max_hp: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Kill { time_s: f32, victim: u32, killer: Option<u32>, assisters: Vec<u32> },
    Purchase { time_s: f32, account_id: u32, item_id: u32 },
    LevelUp { time_s: f32, account_id: u32, level: i32 },
    ObjectiveDestroyed { time_s: f32, kind: &'static str, team: Option<u8>, lane: Option<i32> },
}

/// One sample of the match, about twice a second of game time.
#[derive(Clone, Debug, Serialize)]
pub struct Frame {
    pub match_id: u64,
    pub tick: i32,
    /// Game clock (seconds since the match started, pauses excluded); None before the start.
    pub game_time_s: Option<f32>,
    pub paused: bool,
    /// How far the broadcast is behind the real game, from Valve's relay.
    pub delay_s: f32,
    /// World bounds of the minimap (x, y), for converting positions to the map image.
    pub minimap: Option<[f32; 4]>,
    /// The same objective bitmasks as deadlock-api's live list (objectives_mask_team0/1). Valve sends them only when
    /// they change, so a feed that joined mid-match has None until the next objective falls.
    pub objectives_mask: Option<[u64; 2]>,
    pub net_worth: [i64; 2],
    pub winning_team: Option<u8>,
    pub players: Vec<Player>,
    pub objectives: Vec<Objective>,
    pub events: Vec<Event>,
}

fn team_of(num: i64) -> Option<u8> {
    match num {
        2 => Some(0),
        3 => Some(1),
        _ => None,
    }
}

/// An integer field, whether Valve declared it signed or unsigned (haste keeps those as I64 / U64).
fn int(e: &Entity, key: u64) -> Option<i64> {
    e.get_value::<i64>(&key).or_else(|| e.get_value::<u64>(&key).and_then(|v| i64::try_from(v).ok()))
}

fn int32(e: &Entity, key: u64) -> Option<i32> {
    int(e, key).and_then(|v| i32::try_from(v).ok())
}

fn team(e: &Entity) -> Option<u8> {
    int(e, key!("m_iTeamNum")).and_then(team_of)
}

/// World coordinate from a cell and the offset in it. Cells are 512 units wide (haste's value), but the grid is now
/// 128 × 128, so the origin sits at cell 64: the mid-boss, at the exact centre of the map, reads cell 64 with offset 0.
/// haste's `deadlock_coord_from_cell` still assumes a 64 × 64 grid and lands everything 16384 units off.
pub fn world_coord(cell: u16, vec: f32) -> f32 {
    const CELL_WIDTH: f32 = 512.0;
    const ORIGIN: f32 = 64.0 * CELL_WIDTH;
    f32::from(cell) * CELL_WIDTH + vec - ORIGIN
}

fn position(e: &Entity) -> Option<(f32, f32)> {
    let coord = |cell: u64, vec: u64| -> Option<f32> {
        let cell = int(e, cell).and_then(|c| u16::try_from(c).ok())?;
        Some(world_coord(cell, e.get_value::<f32>(&vec)?))
    };
    // Players use the skeleton origin (haste's deadlock-position example); other entities the scene node.
    coord(
        key!("CBodyComponent", "m_skeletonInstance", "m_vecOrigin", "m_cellX"),
        key!("CBodyComponent", "m_skeletonInstance", "m_vecOrigin", "m_vecX"),
    )
    .zip(coord(
        key!("CBodyComponent", "m_skeletonInstance", "m_vecOrigin", "m_cellY"),
        key!("CBodyComponent", "m_skeletonInstance", "m_vecOrigin", "m_vecY"),
    ))
    .or_else(|| {
        coord(key!("CBodyComponent", "m_cellX"), key!("CBodyComponent", "m_vecX"))
            .zip(coord(key!("CBodyComponent", "m_cellY"), key!("CBodyComponent", "m_vecY")))
    })
}

/// Elements of a dynamic array field. The base key holds the length; haste keys element i as base key + hash(i).
fn array_u32(e: &Entity, base: u64, max: usize) -> Vec<u32> {
    let len = int(e, base).and_then(|n| usize::try_from(n).ok()).unwrap_or(0).min(max);
    (0..len)
        .filter_map(|i| int(e, fxhash::add_u64_to_hash(base, fxhash::add_u64_to_hash(0, i as u64))))
        .filter_map(|v| u32::try_from(v).ok())
        .filter(|&v| v != 0)
        .collect()
}

#[derive(Default)]
struct Clock {
    net_tick: u32,
    tick_interval: Option<f32>,
    game_start: Option<f32>,
    paused: bool,
    total_paused_ticks: i32,
}

impl Clock {
    fn game_time(&self) -> Option<f32> {
        let t = (self.net_tick as f32 - self.total_paused_ticks as f32) * self.tick_interval? - self.game_start?;
        Some(t.max(0.0))
    }
}

struct Sampler {
    match_id: u64,
    every_ticks: i32,
    last_sample_tick: i32,
    clock: Clock,
    delay_s: f32,
    minimap: Option<[f32; 4]>,
    masks: Option<[u64; 2]>,
    winning_team: Option<u8>,
    /// What the previous frame said, to turn changes into events.
    previous: HashMap<u32, (i32, Vec<u32>)>,
    previous_objectives: BTreeMap<i32, Objective>,
    pending: Vec<Event>,
    out: Rc<RefCell<Vec<Frame>>>,
}

impl Sampler {
    /// The player whose hero pawn (or controller) has this entity index.
    fn account_of_pawn(&self, ctx: &Context, index: i32) -> Option<u32> {
        let entities = ctx.entities()?;
        if let Some(e) = entities.get(&index)
            && e.serializer_name_heq(CONTROLLER)
        {
            return e.get_value::<u64>(&key!("m_steamID")).map(steam_to_account);
        }
        entities.iter().find_map(|(_, e)| {
            if !e.serializer_name_heq(CONTROLLER) {
                return None;
            }
            let pawn: u32 = e.get_value(&key!("m_hHeroPawn"))?;
            if ehandle_to_index(pawn) != index {
                return None;
            }
            e.get_value::<u64>(&key!("m_steamID")).map(steam_to_account)
        })
    }

    fn sample(&mut self, ctx: &Context) {
        let Some(entities) = ctx.entities() else { return };
        let time_s = self.clock.game_time().unwrap_or(0.0);

        let mut pawns: HashMap<(u32, u8), &Entity> = HashMap::new();
        let mut objectives = Vec::new();
        for (&index, e) in entities.iter() {
            if e.serializer_name_heq(PAWN) {
                let hero = int(e, key!("m_CCitadelHeroComponent", "m_spawnedHero", "m_nHeroID"))
                    .and_then(|h| u32::try_from(h).ok())
                    .filter(|&h| h != 0);
                if let (Some(hero), Some(team)) = (hero, team(e)) {
                    pawns.insert((hero, team), e);
                }
            } else if let Some(&(_, kind)) = OBJECTIVES.iter().find(|(hash, _)| e.serializer_name_heq(*hash)) {
                let hp = int32(e, key!("m_iHealth")).unwrap_or(0);
                let Some((x, y)) = position(e) else { continue };
                if hp <= 0 {
                    continue;
                }
                objectives.push(Objective {
                    id: index,
                    kind,
                    team: team(e),
                    lane: int32(e, key!("m_iLane")),
                    x: x.round(),
                    y: y.round(),
                    hp,
                    max_hp: int32(e, key!("m_iMaxHealth")).unwrap_or(hp).max(hp),
                });
            }
        }

        // Server time, which respawn and cooldown timestamps use.
        let now = self.clock.net_tick as f32 * self.clock.tick_interval.unwrap_or(1.0 / 64.0);
        let mut players = Vec::new();
        for (&index, c) in entities.iter() {
            if !c.serializer_name_heq(CONTROLLER) {
                continue;
            }
            let data = |name: &'static str| int32(c, fxhash::add_u64_to_hash(key!("m_PlayerDataGlobal"), fxhash::hash_bytes(name.as_bytes())));
            let Some(hero_id) = data("m_nHeroID").and_then(|h| u32::try_from(h).ok()).filter(|&h| h != 0) else {
                continue;
            };
            let Some(team) = team(c) else { continue };
            let account_id = c.get_value::<u64>(&key!("m_steamID")).map(steam_to_account).unwrap_or_default();
            let alive = c.get_value::<bool>(&key!("m_PlayerDataGlobal", "m_bAlive")).unwrap_or(true);
            let pos = pawns.get(&(hero_id, team)).and_then(|p| position(p));
            let respawn = c.get_value::<f32>(&key!("m_PlayerDataGlobal", "m_flRespawnTime"));
            players.push(Player {
                slot: index,
                account_id,
                hero_id,
                team,
                level: data("m_iLevel").unwrap_or(0),
                net_worth: data("m_iGoldNetWorth").unwrap_or(0),
                kills: data("m_iPlayerKills").unwrap_or(0),
                deaths: data("m_iDeaths").unwrap_or(0),
                assists: data("m_iPlayerAssists").unwrap_or(0),
                alive,
                respawn_in_s: (!alive).then(|| respawn.map(|r| (r - now).max(0.0))).flatten(),
                ult_ready: c.get_value::<bool>(&key!("m_PlayerDataGlobal", "m_bUltimateTrained")).unwrap_or(false)
                    && c.get_value::<f32>(&key!("m_PlayerDataGlobal", "m_flUltimateCooldownEnd"))
                        .is_none_or(|end| end <= now),
                items: array_u32(c, key!("m_PlayerDataGlobal", "m_vecUpgrades"), 64),
                x: pos.map(|p| p.0.round()),
                y: pos.map(|p| p.1.round()),
                hp: data("m_iHealth"),
                max_hp: data("m_iHealthMax"),
            });
        }
        players.sort_by_key(|p| (p.team, p.slot));

        // Changes since the last frame become events.
        for p in &players {
            if let Some((level, items)) = self.previous.get(&p.account_id) {
                for &item in p.items.iter().filter(|i| !items.contains(i)) {
                    self.pending.push(Event::Purchase { time_s, account_id: p.account_id, item_id: item });
                }
                if p.level > *level {
                    self.pending.push(Event::LevelUp { time_s, account_id: p.account_id, level: p.level });
                }
            }
        }
        self.previous = players.iter().map(|p| (p.account_id, (p.level, p.items.clone()))).collect();
        let standing: BTreeMap<i32, Objective> = objectives.iter().map(|o| (o.id, o.clone())).collect();
        for (id, gone) in &self.previous_objectives {
            if !standing.contains_key(id) && gone.kind != "midboss" {
                self.pending.push(Event::ObjectiveDestroyed { time_s, kind: gone.kind, team: gone.team, lane: gone.lane });
            }
        }
        self.previous_objectives = standing;

        let mut net_worth = [0i64; 2];
        for p in &players {
            net_worth[p.team as usize] += i64::from(p.net_worth);
        }
        self.out.borrow_mut().push(Frame {
            match_id: self.match_id,
            tick: ctx.tick(),
            game_time_s: self.clock.game_time(),
            paused: self.clock.paused,
            delay_s: self.delay_s,
            minimap: self.minimap,
            objectives_mask: self.masks,
            net_worth,
            winning_team: self.winning_team,
            players,
            objectives,
            events: std::mem::take(&mut self.pending),
        });
    }
}

fn steam_to_account(steam_id: u64) -> u32 {
    if steam_id > STEAM_ID_BASE { (steam_id - STEAM_ID_BASE) as u32 } else { steam_id as u32 }
}

impl Visitor for Sampler {
    fn on_cmd(&mut self, ctx: &Context, cmd_header: &CmdHeader, _data: &[u8]) -> Result<()> {
        if self.clock.tick_interval.is_none() && cmd_header.cmd == EDemoCommands::DemSyncTick {
            self.clock.tick_interval = Some(ctx.tick_interval());
        }
        Ok(())
    }

    fn on_packet(&mut self, ctx: &Context, packet_type: u32, data: &[u8]) -> Result<()> {
        match packet_type {
            t if t == NetMessages::NetTick as u32 => {
                if let Some(tick) = CnetMsgTick::decode(data)?.tick {
                    self.clock.net_tick = tick;
                }
            }
            MSG_OBJECTIVE_MASK => {
                let msg = CCitadelUserMessageObjectiveMask::decode(data)?;
                let old = self.masks.unwrap_or([0, 0]);
                self.masks = Some([msg.objective_mask_team0.unwrap_or(old[0]), msg.objective_mask_team1.unwrap_or(old[1])]);
            }
            MSG_HERO_KILLED => {
                let msg = CCitadelUserMsgHeroKilled::decode(data)?;
                let time_s = self.clock.game_time().unwrap_or(0.0);
                if let Some(victim) = msg.entindex_victim.and_then(|i| self.account_of_pawn(ctx, i)) {
                    let killer = msg.entindex_attacker.and_then(|i| self.account_of_pawn(ctx, i)).filter(|&k| k != victim);
                    let assisters = msg.entindex_assisters.iter().filter_map(|&i| self.account_of_pawn(ctx, i)).collect();
                    self.pending.push(Event::Kill { time_s, victim, killer, assisters });
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn on_entity(&mut self, _ctx: &Context, _delta: DeltaHeader, e: &Entity) -> Result<()> {
        if e.serializer_name_heq(GAME_RULES) {
            if let Some(start) = e.get_value::<f32>(&key!("m_pGameRules", "m_flGameStartTime")).filter(|&s| s > 0.001) {
                self.clock.game_start = Some(start);
            }
            self.clock.paused = e.get_value(&key!("m_pGameRules", "m_bGamePaused")).unwrap_or(false);
            self.clock.total_paused_ticks = e.get_value(&key!("m_pGameRules", "m_nTotalPausedTicks")).unwrap_or(0);
            let mins: Option<[f32; 3]> = e.get_value(&key!("m_pGameRules", "m_vMinimapMins"));
            let maxs: Option<[f32; 3]> = e.get_value(&key!("m_pGameRules", "m_vMinimapMaxs"));
            if let (Some(a), Some(b)) = (mins, maxs) {
                self.minimap = Some([a[0], a[1], b[0], b[1]]);
            }
            self.winning_team = int(e, key!("m_pGameRules", "m_iWinningTeam")).and_then(team_of);
        }
        Ok(())
    }

    fn on_tick_end(&mut self, ctx: &Context) -> Result<()> {
        // Broadcasts don't send DemSyncTick; the interval is known once the server info arrived.
        if self.clock.tick_interval.is_none() && ctx.tick_interval() > 0.0 {
            self.clock.tick_interval = Some(ctx.tick_interval());
        }
        let tick = ctx.tick();
        if tick > 0 && tick - self.last_sample_tick >= self.every_ticks && self.clock.tick_interval.is_some() {
            self.last_sample_tick = tick;
            self.sample(ctx);
        }
        Ok(())
    }
}

fn parser_sync<C: haste::broadcast::HttpClient>(stream: &BroadcastHttp<'_, C>) -> (i32, i32, i32, f32) {
    let s = stream.sync_response();
    (s.tick, s.fragment, s.signup_fragment, s.rtdelay)
}

/// Valve's broadcast URLs look like `http://dist1-ord1.steamcontent.com/tv/<match_id>_<n>`.
pub fn match_id_from_url(url: &str) -> Option<u64> {
    url.trim_end_matches('/').rsplit('/').next()?.split('_').next()?.parse().ok()
}

/// Follows one broadcast until it ends, calling `on_frames` after each fragment (every ~3 s of game, with about 6
/// frames). Returns when the broadcast ends or `on_frames` returns false.
pub async fn follow(
    broadcast_url: &str,
    match_id: u64,
    every_ticks: i32,
    mut on_frames: impl FnMut(Vec<Frame>) -> bool,
) -> Result<()> {
    let headers = haste::broadcast::default_headers(DEADLOCK_APP_ID)?;
    let http = reqwest012::Client::builder()
        .timeout(Duration::from_secs(10))
        .default_headers(headers)
        .build()?;
    let stream = BroadcastHttp::start_streaming(http, broadcast_url.trim_end_matches('/').to_owned())
        .await
        .with_context(|| format!("could not start the broadcast {broadcast_url}"))?;
    let delay_s = stream.sync_response().rtdelay;
    let out = Rc::new(RefCell::new(Vec::new()));
    let sampler = Sampler {
        match_id,
        every_ticks,
        last_sample_tick: i32::MIN / 2,
        clock: Clock::default(),
        delay_s,
        minimap: None,
        masks: None,
        winning_team: None,
        previous: HashMap::new(),
        previous_objectives: BTreeMap::new(),
        pending: Vec::new(),
        out: out.clone(),
    };
    log::debug!("broadcast {broadcast_url}: sync {:?}", parser_sync(&stream));
    let mut parser = Parser::from_stream_with_visitor(stream, sampler).context("could not read the broadcast header")?;
    loop {
        match parser.demo_stream_mut().next_packet().await {
            Some(Ok(packet)) => {
                log::debug!("fragment of {} bytes", packet.len());
                parser.run_to_end().context("could not parse the broadcast")?;
                log::debug!("parsed up to tick {}", parser.context().tick());
            }
            Some(Err(e)) => return Err(e).context("the broadcast stopped"),
            None => return Ok(()), // ended
        }
        let frames = std::mem::take(&mut *out.borrow_mut());
        if !frames.is_empty() && !on_frames(frames) {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mid_boss_cell_is_the_map_centre() {
        // Measured on a live broadcast: CNPC_MidBoss sits at cell 64, offset 0, on both axes.
        assert_eq!(world_coord(64, 0.0), 0.0);
        assert_eq!(world_coord(65, 12.5), 524.5);
        // The patrons were at about y = ±8040, inside the ±10752 minimap.
        assert!((world_coord(48, 158.0) - -8034.0).abs() < 1.0);
    }

    #[test]
    fn reads_the_match_id_from_a_broadcast_url() {
        assert_eq!(match_id_from_url("http://dist1-ord1.steamcontent.com/tv/127348911_412616904"), Some(127_348_911));
        assert_eq!(match_id_from_url("http://dist1-ord1.steamcontent.com/tv/127348911_412616904/"), Some(127_348_911));
        assert_eq!(match_id_from_url("nonsense"), None);
    }

    #[test]
    fn maps_valve_team_numbers_like_deadlock_api() {
        assert_eq!(team_of(2), Some(0));
        assert_eq!(team_of(3), Some(1));
        assert_eq!(team_of(1), None); // spectators
    }

    #[test]
    fn converts_steam_ids_to_account_ids() {
        assert_eq!(steam_to_account(76_561_198_348_236_050), 387_970_322);
        assert_eq!(steam_to_account(387_970_322), 387_970_322);
    }

    #[test]
    fn game_clock_excludes_pauses_and_the_pre_game() {
        let clock = Clock { net_tick: 64 * 100, tick_interval: Some(1.0 / 64.0), game_start: Some(20.0), paused: false, total_paused_ticks: 64 * 10 };
        assert_eq!(clock.game_time(), Some(70.0));
        assert_eq!(Clock::default().game_time(), None);
    }
}
