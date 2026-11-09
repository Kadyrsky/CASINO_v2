//! Live map feed: reads a match's Valve broadcast (the stream the in-game spectator uses, served over HTTP by
//! Valve's relays) with the [haste](https://github.com/blukai/haste) parser and turns it into compact frames:
//! every hero's position, health, level, souls, K/D/A, items and abilities, the objectives still standing, the Soul
//! Urn, the Unstable Rift, the neutral camps (with the Sinner's Sacrifices and the Mid-Boss respawn) and the bridge
//! power-ups, and events (kills, purchases, abilities unlocked and upgraded, objectives destroyed, Mid-Boss, urn and
//! rift). The broadcast runs about 20 s behind the real game.
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
use haste::valveprotos::deadlock::{CCitadelUserMessageObjectiveMask, CCitadelUserMsgBossKilled, CCitadelUserMsgHeroKilled};
use haste::valveprotos::prost::Message;
use serde::Serialize;

use crate::gc::DEADLOCK_APP_ID;

const MSG_HERO_KILLED: u32 = 319;
const MSG_OBJECTIVE_MASK: u32 = 324;
const MSG_BOSS_KILLED: u32 = 347;
/// `objective_team` of a `BossKilled` message for the Mid-Boss (the neutral team; seen on live broadcasts).
const NEUTRAL_TEAM: i32 = 4;
/// Steam IDs are 64-bit; Deadlock account ids are the low 32 bits.
const STEAM_ID_BASE: u64 = 76_561_197_960_265_728;
/// An entity handle that points at nothing.
const NO_HANDLE: u32 = 0xFF_FFFF;

const CONTROLLER: u64 = fxhash::hash_bytes(b"CCitadelPlayerController");
const PAWN: u64 = fxhash::hash_bytes(b"CCitadelPlayerPawn");
const GAME_RULES: u64 = fxhash::hash_bytes(b"CCitadelGameRulesProxy");

// The Soul Urn ("idol" in the game's code), as seen on live broadcasts: on the ground it is a pickup; a player who
// carries it has the GoldenIdol ability; picking it up enables one of the two return triggers, where it is delivered.
const URN: u64 = fxhash::hash_bytes(b"CCitadelItemPickupIdol");
const URN_CARRIED: u64 = fxhash::hash_bytes(b"CCitadel_Ability_GoldenIdol");
const URN_DELIVERY: u64 = fxhash::hash_bytes(b"CCitadelIdolReturnTrigger");
// The Unstable Rift ("KOTH" in the game's code): the spawner stands on a side-lane bridge for about 76 s, then the
// capture point (the cash-in) opens there. Capture progress, the deadline and the winner are in the game rules.
const RIFT_SPAWNER: u64 = fxhash::hash_bytes(b"CCitadelItemKothSpawner");
const RIFT_OPEN: u64 = fxhash::hash_bytes(b"CCitadel_KothCashIn");
/// How long after the spawner appears the rift opens: 5126 ticks on every live broadcast measured.
const RIFT_OPENS_AFTER_S: f32 = 80.1;
/// A Sinner's Sacrifice (the "vault" camps): 500 health, taken 100 at a time, souls for every hit.
const SINNER: u64 = fxhash::hash_bytes(b"CNPC_Neutral_SinnersSacrifice");
/// The two bridge power-up spawners (both drop at once, every few minutes).
const POWERUP_SPAWNER: u64 = fxhash::hash_bytes(b"CCitadel_PickupItemSpawner");

const ITEM_ID: u64 = fxhash::hash_bytes(b"m_ItemID");
const UPGRADE_INFO: u64 = fxhash::hash_bytes(b"m_nUpgradeInfo");
const CAPTURE_PROGRESS: u64 = fxhash::hash_bytes(b"m_flCaptureProgressFrac");
const CAPTURER_COUNT: u64 = fxhash::hash_bytes(b"m_nCapturerCount");
const IS_BLOCKED: u64 = fxhash::hash_bytes(b"m_bIsBlocked");
const PARTICIPANTS: u64 = fxhash::hash_bytes(b"m_vecParticipants");
/// Valve's "no value" for times and positions (FLT_MAX).
const UNSET: f32 = 1e30;

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
    /// The hero's four abilities in slot order (the fourth is the ultimate).
    pub abilities: Vec<Ability>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub hp: Option<i32>,
    pub max_hp: Option<i32>,
    /// Souls not spent yet.
    pub souls: Option<i32>,
    pub last_hits: Option<i32>,
    pub denies: Option<i32>,
    pub hero_damage: Option<i32>,
    pub objective_damage: Option<i32>,
}

/// One of a hero's abilities: locked until unlocked, then up to three ability points.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct Ability {
    pub id: u32,
    pub unlocked: bool,
    /// Ability points put into it, 0 to 3.
    pub tier: u32,
}

/// A neutral camp's in-game timer (the circle the minimap shows when a camp is down). Camps here include the
/// Sinner's Sacrifices; the Mid-Boss has its own timer ([`Frame::midboss_respawn_in_s`]).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Camp {
    /// Position in the game's timer list (stable for the match).
    pub id: usize,
    pub x: f32,
    pub y: f32,
    /// Seconds until it is back; None while it is up.
    pub respawn_in_s: Option<f32>,
}

/// A Sinner's Sacrifice that still has health.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Sinner {
    pub x: f32,
    pub y: f32,
    pub hp: i32,
    pub max_hp: i32,
}

/// A bridge power-up waiting to be picked up.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Powerup {
    pub x: f32,
    pub y: f32,
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

/// The Soul Urn while it is in play.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Urn {
    pub x: f32,
    pub y: f32,
    /// The player carrying it; None while it lies on the ground.
    pub carrier: Option<u32>,
    /// Where it has to be taken, once someone has picked it up.
    pub delivery: Option<[f32; 2]>,
    /// Souls it gives the team that delivers it.
    pub value: Option<i32>,
}

/// The Unstable Rift: appearing on a side lane, then open as a capture point for about a minute.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Rift {
    pub x: f32,
    pub y: f32,
    pub open: bool,
    /// Seconds until an appearing rift opens.
    pub opens_in_s: Option<f32>,
    /// Each team's capture progress, 0 to 1.
    pub progress: [f32; 2],
    /// Each team's players on the point.
    pub capturers: [i32; 2],
    /// Both teams are on the point, so neither makes progress.
    pub contested: bool,
    /// Hero ids of each team's players on the point.
    pub heroes: [Vec<u32>; 2],
    /// Seconds until an open rift closes if nobody captures it.
    pub closes_in_s: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Kill { time_s: f32, victim: u32, killer: Option<u32>, assisters: Vec<u32> },
    Purchase { time_s: f32, account_id: u32, item_id: u32 },
    LevelUp { time_s: f32, account_id: u32, level: i32 },
    /// Abilities start locked; unlocking one makes it usable.
    AbilityUnlocked { time_s: f32, account_id: u32, ability_id: u32 },
    /// An ability point put into an unlocked ability: tier 1 to 3.
    AbilityUpgraded { time_s: f32, account_id: u32, ability_id: u32, tier: u32 },
    ObjectiveDestroyed { time_s: f32, kind: &'static str, team: Option<u8>, lane: Option<i32> },
    /// The Mid-Boss fell to `killer` (when it was a hero) of `team`.
    MidbossKilled { time_s: f32, team: Option<u8>, killer: Option<u32> },
    UrnSpawned { time_s: f32 },
    UrnPickedUp { time_s: f32, account_id: u32 },
    UrnDropped { time_s: f32, account_id: u32 },
    UrnDelivered { time_s: f32, account_id: u32, team: u8 },
    RiftAppeared { time_s: f32 },
    RiftOpened { time_s: f32 },
    RiftCaptured { time_s: f32, team: u8 },
    /// Nobody captured the open rift in time.
    RiftClosed { time_s: f32 },
}

/// Whether an ability is unlocked, and how many ability points went into it (0 to 3). Read from live broadcasts: the
/// unlock is bit 16 of `m_nUpgradeInfo`, each point one more bit above it (0x10000, 0x30000, 0x70000, 0xF0000).
fn ability_level(info: u32) -> (bool, u32) {
    let bits = (info >> 16) & 0xF;
    (bits & 1 != 0, (bits >> 1).count_ones())
}

fn ability_states(raw: &[(u32, u32)]) -> Vec<Ability> {
    raw.iter()
        .map(|&(id, info)| {
            let (unlocked, tier) = ability_level(info);
            Ability { id, unlocked, tier }
        })
        .collect()
}

/// One camp timer from the game rules: where, when it comes back (server time; negative while it is up), and
/// whether it is the Mid-Boss's.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct CampTimer {
    /// Position in the game's list.
    id: usize,
    x: f32,
    y: f32,
    next_spawn: f32,
    midboss: bool,
}

/// The camps to show and the Mid-Boss's respawn, at server time `now`.
fn camps_at(timers: &[CampTimer], now: f32) -> (Vec<Camp>, Option<f32>) {
    let left = |t: &CampTimer| (t.next_spawn > 0.0 && t.next_spawn < UNSET).then(|| (t.next_spawn - now).max(0.0));
    let camps = timers
        .iter()
        .filter(|t| !t.midboss)
        .map(|t| Camp { id: t.id, x: t.x.round(), y: t.y.round(), respawn_in_s: left(t).map(|s| s.round()) })
        .collect();
    let midboss = timers.iter().filter(|t| t.midboss).find_map(left).map(f32::round);
    (camps, midboss)
}

/// A position Valve set (not FLT_MAX, and not the origin it holds before the first rift).
fn valid_location(v: [f32; 3]) -> Option<[f32; 2]> {
    (v[0].abs() < UNSET && v[1].abs() < UNSET && (v[0], v[1]) != (0.0, 0.0)).then_some([v[0], v[1]])
}

/// The events between two readings of one player's abilities (ability id, upgrade info).
fn ability_events(time_s: f32, account_id: u32, before: &[(u32, u32)], now: &[(u32, u32)]) -> Vec<Event> {
    let mut out = Vec::new();
    for &(ability_id, info) in now {
        let Some(&(_, old)) = before.iter().find(|(id, _)| *id == ability_id) else { continue };
        let ((was_unlocked, was_tier), (unlocked, tier)) = (ability_level(old), ability_level(info));
        if unlocked && !was_unlocked {
            out.push(Event::AbilityUnlocked { time_s, account_id, ability_id });
        }
        for tier in (was_tier + 1)..=tier {
            out.push(Event::AbilityUpgraded { time_s, account_id, ability_id, tier });
        }
    }
    out
}

/// The urn events between two frames. `team_of_player` gives a carrier's team for deliveries.
fn urn_events(time_s: f32, before: Option<&Urn>, now: Option<&Urn>, team_of_player: impl Fn(u32) -> Option<u8>) -> Vec<Event> {
    match (before.map(|u| u.carrier), now.map(|u| u.carrier)) {
        (None, Some(None)) => vec![Event::UrnSpawned { time_s }],
        (None | Some(None), Some(Some(a))) => vec![Event::UrnPickedUp { time_s, account_id: a }],
        (Some(Some(a)), Some(Some(b))) if a != b => vec![Event::UrnPickedUp { time_s, account_id: b }],
        (Some(Some(a)), Some(None)) => vec![Event::UrnDropped { time_s, account_id: a }],
        // Carried one frame, gone the next: delivered.
        (Some(Some(a)), None) => team_of_player(a)
            .map(|team| Event::UrnDelivered { time_s, account_id: a, team })
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

/// The rift events between two frames. `captured_now` is the team that captured it since the last frame (the game
/// rules' scoring time changed); `captured_earlier` says this rift was already captured, so its removal is no close.
fn rift_events(time_s: f32, before: Option<&Rift>, now: Option<&Rift>, captured_now: Option<u8>, captured_earlier: bool) -> Vec<Event> {
    let mut out = Vec::new();
    match (before, now) {
        (None, Some(r)) if !r.open => out.push(Event::RiftAppeared { time_s }),
        (None, Some(_)) => out.push(Event::RiftOpened { time_s }),
        (Some(b), Some(r)) if !b.open && r.open => out.push(Event::RiftOpened { time_s }),
        (Some(b), None) if b.open && !captured_earlier && captured_now.is_none() => out.push(Event::RiftClosed { time_s }),
        _ => {}
    }
    if let Some(team) = captured_now {
        out.push(Event::RiftCaptured { time_s, team });
    }
    out
}

/// What the game rules say about the rift (updated as they change). Read from live broadcasts: nothing while it
/// appears (the spawner entity stands there for 80 s); when it opens, `m_timeKothCashInStarted` and
/// `m_vKothCashInCurrentLocation` are set, and `m_timeKothGiveUp` a moment later to a minute after the start (FLT_MAX
/// until then). A capture sets the scoring team and time, then the start, give-up and location are cleared.
#[derive(Default)]
struct RiftRules {
    /// Server time when an open rift gives up; 0 or FLT_MAX while none is open.
    give_up: f32,
    location: Option<[f32; 2]>,
    /// Server time of the last capture; a new value means a new capture.
    scoring_time: f32,
    scoring_team: Option<u8>,
    /// Per team (Hidden King first), from `m_vecTeamKothStates`.
    progress: [f32; 2],
    capturers: [i32; 2],
    blocked: [bool; 2],
    heroes: [Vec<u32>; 2],
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
    pub urn: Option<Urn>,
    pub rift: Option<Rift>,
    pub camps: Vec<Camp>,
    /// Seconds until the Mid-Boss is back, while it is dead.
    pub midboss_respawn_in_s: Option<f32>,
    pub sinners: Vec<Sinner>,
    pub powerups: Vec<Powerup>,
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

/// Key of element `i` of a dynamic array field (haste keys it as base key + hash(i)); struct members add their name.
fn element(base: u64, i: usize) -> u64 {
    fxhash::add_u64_to_hash(base, fxhash::add_u64_to_hash(0, i as u64))
}

/// A player's four abilities as (ability id, upgrade info), from the controller.
fn abilities(c: &Entity) -> Vec<(u32, u32)> {
    let base = key!("m_PlayerDataGlobal", "m_vecAbilityUpgradeState");
    let len = int(c, base).and_then(|n| usize::try_from(n).ok()).unwrap_or(0).min(8);
    (0..len)
        .filter_map(|i| {
            let el = element(base, i);
            let id = int(c, fxhash::add_u64_to_hash(el, ITEM_ID)).and_then(|v| u32::try_from(v).ok()).filter(|&v| v != 0)?;
            let info = int(c, fxhash::add_u64_to_hash(el, UPGRADE_INFO)).and_then(|v| u32::try_from(v).ok()).unwrap_or(0);
            Some((id, info))
        })
        .collect()
}

/// The game rules' camp timers: three parallel arrays (origin, next spawn time, is the Mid-Boss), one entry per camp,
/// in a fixed order. Measured on live broadcasts: the next spawn time is -1 while a camp is up and is set when it is
/// cleared (weak camps come back after 85 s, medium 290 s, strong 335 s, Sinner's Sacrifices 300 s, the Mid-Boss
/// 7 min); the origins are the camps' positions in deadlock-api's map data.
fn camp_timers(rules: &Entity) -> Vec<CampTimer> {
    let origins = key!("m_pGameRules", "m_vecNeutralCampTimerOrigins");
    let next = key!("m_pGameRules", "m_vecNeutralCampNextSpawnTimes");
    let midboss = key!("m_pGameRules", "m_vecNeutralCampTimerIsMidBoss");
    let len = int(rules, origins).and_then(|n| usize::try_from(n).ok()).unwrap_or(0).min(128);
    (0..len)
        .filter_map(|i| {
            let [x, y, _] = rules.get_value::<[f32; 3]>(&element(origins, i))?;
            Some(CampTimer {
                id: i,
                x,
                y,
                next_spawn: rules.get_value(&element(next, i)).unwrap_or(-1.0),
                midboss: rules.get_value(&element(midboss, i)).unwrap_or(false),
            })
        })
        .collect()
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
    rift_rules: RiftRules,
    camp_timers: Vec<CampTimer>,
    /// The urn's value, kept while it is carried (only the pickup on the ground has it).
    urn_value: Option<i32>,
    /// What the previous frame said, to turn changes into events.
    previous: HashMap<u32, (i32, Vec<u32>)>,
    previous_abilities: HashMap<u32, Vec<(u32, u32)>>,
    previous_objectives: BTreeMap<i32, Objective>,
    previous_urn: Option<Urn>,
    previous_rift: Option<Rift>,
    previous_scoring_time: f32,
    rift_captured: bool,
    /// False until the first frame, so a feed that joins mid-match reports nothing that happened before.
    primed: bool,
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
        let (mut urn_ground, mut urn_pawn, mut urn_delivery) = (None, None, None);
        let (mut rift_spawner, mut rift_open, mut rift_spawned_at) = (None, None, None);
        let (mut sinners, mut powerups) = (Vec::new(), Vec::new());
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
            } else if e.serializer_name_heq(URN) {
                if urn_ground.is_none() {
                    urn_ground = position(e);
                    if let Some(v) = int32(e, key!("m_nCurrencyValue")).filter(|&v| v > 0) {
                        self.urn_value = Some(v);
                    }
                }
            } else if e.serializer_name_heq(SINNER) {
                // A cracked sacrifice keeps 1 health until its camp comes back.
                let hp = int32(e, key!("m_iHealth")).unwrap_or(0);
                if let (Some((x, y)), true) = (position(e), hp > 1) {
                    let max_hp = int32(e, key!("m_iMaxHealth")).unwrap_or(hp).max(hp);
                    sinners.push(Sinner { x: x.round(), y: y.round(), hp, max_hp });
                }
            } else if e.serializer_name_heq(POWERUP_SPAWNER) {
                if e.get_value::<bool>(&key!("m_bPowerupActive")) == Some(true)
                    && let Some((x, y)) = position(e)
                {
                    powerups.push(Powerup { x: x.round(), y: y.round() });
                }
            } else if e.serializer_name_heq(URN_CARRIED) {
                // Attached to the carrier's hero.
                urn_pawn = int(e, key!("CBodyComponent", "m_hParent"))
                    .or_else(|| int(e, key!("m_hOwnerEntity")))
                    .and_then(|h| u32::try_from(h).ok())
                    .filter(|&h| h != NO_HANDLE)
                    .map(ehandle_to_index);
            } else if e.serializer_name_heq(URN_DELIVERY) {
                if e.get_value::<bool>(&key!("m_bDisabled")) == Some(false) {
                    urn_delivery = position(e);
                }
            } else if e.serializer_name_heq(RIFT_SPAWNER) {
                if rift_spawner.is_none() {
                    rift_spawner = position(e);
                    rift_spawned_at = e.get_value::<f32>(&key!("m_flCreateTime"));
                }
            } else if e.serializer_name_heq(RIFT_OPEN) && e.get_value::<bool>(&key!("m_bDisabled")) != Some(true) {
                rift_open = rift_open.or_else(|| position(e));
            }
        }

        // Server time, which respawn and cooldown timestamps use.
        let now = self.clock.net_tick as f32 * self.clock.tick_interval.unwrap_or(1.0 / 64.0);
        let mut players = Vec::new();
        let mut abilities_now: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
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
            let raw_abilities = abilities(c);
            let ability_list = ability_states(&raw_abilities);
            abilities_now.insert(account_id, raw_abilities);
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
                abilities: ability_list,
                x: pos.map(|p| p.0.round()),
                y: pos.map(|p| p.1.round()),
                hp: data("m_iHealth"),
                max_hp: data("m_iHealthMax"),
                souls: data("m_iGold"),
                last_hits: data("m_iLastHits"),
                denies: data("m_iDenies"),
                hero_damage: data("m_iHeroDamage"),
                objective_damage: data("m_iObjectiveDamage"),
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
        for (account_id, now) in &abilities_now {
            if let Some(before) = self.previous_abilities.get(account_id) {
                self.pending.extend(ability_events(time_s, *account_id, before, now));
            }
        }
        self.previous_abilities = abilities_now;

        // The urn: carried (at the carrier), on the ground, or not in play.
        let carrier = urn_pawn.and_then(|i| self.account_of_pawn(ctx, i));
        let delivery = urn_delivery.map(|(x, y): (f32, f32)| [x.round(), y.round()]);
        let value = self.urn_value;
        let urn = match carrier {
            Some(a) => players
                .iter()
                .find(|p| p.account_id == a)
                .and_then(|p| p.x.zip(p.y))
                .or_else(|| self.previous_urn.as_ref().map(|u| (u.x, u.y)))
                .map(|(x, y)| Urn { x, y, carrier: Some(a), delivery, value }),
            None => urn_ground.map(|(x, y)| Urn { x: x.round(), y: y.round(), carrier: None, delivery, value }),
        };
        if urn.is_none() {
            self.urn_value = None;
        }
        // The rift: open (with the game rules' progress), appearing, or not in play. The game rules have its exact
        // spot; the entities stand a little off it.
        let rules = &self.rift_rules;
        let until = |t: f32| (t > 0.0 && t < UNSET).then(|| (t - now).max(0.0).round());
        let rift = match (rift_open, rift_spawner) {
            (Some(at), _) => {
                let [x, y] = rules.location.unwrap_or([at.0, at.1]);
                Some(Rift {
                    x: x.round(),
                    y: y.round(),
                    open: true,
                    opens_in_s: None,
                    progress: rules.progress,
                    capturers: rules.capturers,
                    contested: rules.blocked.contains(&true) && rules.capturers.iter().all(|&n| n > 0),
                    heroes: rules.heroes.clone(),
                    closes_in_s: until(rules.give_up),
                })
            }
            (None, Some(at)) => {
                let [x, y] = rules.location.unwrap_or([at.0, at.1]);
                Some(Rift {
                    x: x.round(),
                    y: y.round(),
                    open: false,
                    opens_in_s: rift_spawned_at.and_then(|t| until(t + RIFT_OPENS_AFTER_S)),
                    progress: [0.0; 2],
                    capturers: [0; 2],
                    contested: false,
                    heroes: [Vec::new(), Vec::new()],
                    closes_in_s: None,
                })
            }
            (None, None) => None,
        };
        let captured_now = (rules.scoring_time > 0.0 && rules.scoring_time != self.previous_scoring_time)
            .then_some(rules.scoring_team)
            .flatten();
        if self.primed {
            let team_of_player = |a: u32| players.iter().find(|p| p.account_id == a).map(|p| p.team);
            self.pending.extend(urn_events(time_s, self.previous_urn.as_ref(), urn.as_ref(), team_of_player));
            self.pending.extend(rift_events(time_s, self.previous_rift.as_ref(), rift.as_ref(), captured_now, self.rift_captured));
        }
        let (camps, midboss_respawn_in_s) = camps_at(&self.camp_timers, now);
        self.rift_captured = rift.is_some() && (self.rift_captured || captured_now.is_some());
        self.previous_scoring_time = self.rift_rules.scoring_time;
        self.previous_urn = urn.clone();
        self.previous_rift = rift.clone();

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
            urn,
            rift,
            camps,
            midboss_respawn_in_s,
            sinners,
            powerups,
            events: std::mem::take(&mut self.pending),
        });
        self.primed = true;
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
            MSG_BOSS_KILLED => {
                let msg = CCitadelUserMsgBossKilled::decode(data)?;
                if msg.objective_team == Some(NEUTRAL_TEAM) {
                    let time_s = self.clock.game_time().unwrap_or(0.0);
                    let killer = (msg.entity_killer != NO_HANDLE).then(|| ehandle_to_index(msg.entity_killer));
                    let team = killer.and_then(|i| ctx.entities()?.get(&i).and_then(team));
                    let killer = killer.and_then(|i| self.account_of_pawn(ctx, i));
                    self.pending.push(Event::MidbossKilled { time_s, team, killer });
                }
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
            let rift = &mut self.rift_rules;
            rift.give_up = e.get_value(&key!("m_pGameRules", "m_timeKothGiveUp")).unwrap_or(0.0);
            rift.location = e.get_value(&key!("m_pGameRules", "m_vKothCashInCurrentLocation")).and_then(valid_location);
            rift.scoring_time = e.get_value(&key!("m_pGameRules", "m_timeKothScoring")).unwrap_or(0.0);
            rift.scoring_team = int(e, key!("m_pGameRules", "m_nKothScoringTeam")).and_then(team_of);
            let states = key!("m_pGameRules", "m_vecTeamKothStates");
            for team in 0..2 {
                let el = element(states, team);
                rift.progress[team] = e.get_value::<f32>(&fxhash::add_u64_to_hash(el, CAPTURE_PROGRESS)).unwrap_or(0.0).clamp(0.0, 1.0);
                rift.capturers[team] = int32(e, fxhash::add_u64_to_hash(el, CAPTURER_COUNT)).unwrap_or(0);
                rift.blocked[team] = e.get_value(&fxhash::add_u64_to_hash(el, IS_BLOCKED)).unwrap_or(false);
                rift.heroes[team] = array_u32(e, fxhash::add_u64_to_hash(el, PARTICIPANTS), 6);
            }
            self.camp_timers = camp_timers(e);
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
        rift_rules: RiftRules::default(),
        camp_timers: Vec::new(),
        urn_value: None,
        previous: HashMap::new(),
        previous_abilities: HashMap::new(),
        previous_objectives: BTreeMap::new(),
        previous_urn: None,
        previous_rift: None,
        previous_scoring_time: 0.0,
        rift_captured: false,
        primed: false,
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

    fn names(events: &[Event]) -> Vec<String> {
        events.iter().map(|e| serde_json::to_value(e).unwrap()["type"].as_str().unwrap().to_owned()).collect()
    }

    #[test]
    fn reads_ability_unlocks_and_points_like_live_broadcasts() {
        // The values seen on broadcasts: locked, unlocked, then one bit more per ability point.
        assert_eq!(ability_level(0), (false, 0));
        assert_eq!(ability_level(0x10000), (true, 0));
        assert_eq!(ability_level(0x30000), (true, 1));
        assert_eq!(ability_level(0x70000), (true, 2));
        assert_eq!(ability_level(0xF0000), (true, 3));
    }

    #[test]
    fn ability_changes_become_events() {
        let before = [(11, 0), (22, 0x10000), (33, 0x70000)];
        let now = [(11, 0x10000), (22, 0x70000), (33, 0x70000)];
        let events = ability_events(5.0, 7, &before, &now);
        assert_eq!(names(&events), ["ability_unlocked", "ability_upgraded", "ability_upgraded"]);
        let json = serde_json::to_value(&events[2]).unwrap();
        assert_eq!((json["ability_id"].as_u64(), json["tier"].as_u64()), (Some(22), Some(2)));
        assert!(ability_events(5.0, 7, &now, &now).is_empty());
    }

    #[test]
    fn urn_spawn_pickup_drop_and_delivery() {
        let ground = Urn { x: 1.0, y: 2.0, carrier: None, delivery: None, value: Some(950) };
        let carried = |a| Urn { x: 1.0, y: 2.0, carrier: Some(a), delivery: Some([6304.0, -96.0]), value: Some(950) };
        let team = |a: u32| Some(if a == 1 { 0 } else { 1 });
        assert_eq!(names(&urn_events(0.0, None, Some(&ground), team)), ["urn_spawned"]);
        assert_eq!(names(&urn_events(0.0, Some(&ground), Some(&carried(1)), team)), ["urn_picked_up"]);
        assert_eq!(names(&urn_events(0.0, Some(&carried(1)), Some(&ground), team)), ["urn_dropped"]);
        let delivered = urn_events(0.0, Some(&carried(2)), None, team);
        assert_eq!(names(&delivered), ["urn_delivered"]);
        assert_eq!(serde_json::to_value(&delivered[0]).unwrap()["team"], 1);
        assert!(urn_events(0.0, Some(&ground), None, team).is_empty()); // gone from the ground: not a delivery
    }

    #[test]
    fn rift_appears_opens_and_is_captured_or_closes() {
        let appearing = Rift {
            x: -7648.0,
            y: 0.0,
            open: false,
            opens_in_s: Some(70.0),
            progress: [0.0; 2],
            capturers: [0; 2],
            contested: false,
            heroes: [Vec::new(), Vec::new()],
            closes_in_s: None,
        };
        let open = Rift { open: true, opens_in_s: None, closes_in_s: Some(60.0), ..appearing.clone() };
        assert_eq!(names(&rift_events(0.0, None, Some(&appearing), None, false)), ["rift_appeared"]);
        assert_eq!(names(&rift_events(0.0, Some(&appearing), Some(&open), None, false)), ["rift_opened"]);
        // Captured while the point still stands, then removed: one capture, no close.
        assert_eq!(names(&rift_events(0.0, Some(&open), Some(&open), Some(0), false)), ["rift_captured"]);
        assert!(rift_events(0.0, Some(&open), None, None, true).is_empty());
        // Captured and removed in the same frame.
        assert_eq!(names(&rift_events(0.0, Some(&open), None, Some(1), false)), ["rift_captured"]);
        // Nobody took it in time.
        assert_eq!(names(&rift_events(0.0, Some(&open), None, None, false)), ["rift_closed"]);
    }

    #[test]
    fn ability_states_follow_the_upgrade_bits() {
        let states = ability_states(&[(11, 0), (22, 0x10000), (33, 0xF0000)]);
        assert_eq!(
            states,
            [
                Ability { id: 11, unlocked: false, tier: 0 },
                Ability { id: 22, unlocked: true, tier: 0 },
                Ability { id: 33, unlocked: true, tier: 3 },
            ]
        );
    }

    #[test]
    fn camp_timers_become_camps_and_the_midboss_respawn() {
        let timers = [
            CampTimer { id: 0, x: 3248.0, y: -1888.0, next_spawn: -1.0, midboss: false }, // up
            CampTimer { id: 1, x: -1.5, y: -0.8, next_spawn: 1420.0, midboss: true },
            CampTimer { id: 2, x: -3520.0, y: -4384.0, next_spawn: 1100.4, midboss: false }, // down
            CampTimer { id: 3, x: 1.0, y: 1.0, next_spawn: 990.0, midboss: false }, // due: about to be back
        ];
        let (camps, midboss) = camps_at(&timers, 1000.0);
        assert_eq!(camps.iter().map(|c| (c.id, c.respawn_in_s)).collect::<Vec<_>>(), [(0, None), (2, Some(100.0)), (3, Some(0.0))]);
        assert_eq!(midboss, Some(420.0));
        assert_eq!(camps_at(&[CampTimer { midboss: true, next_spawn: -1.0, ..timers[1] }], 0.0).1, None);
    }

    #[test]
    fn rift_locations_ignore_valves_placeholders() {
        assert_eq!(valid_location([-7648.0, 0.0, 420.0]), Some([-7648.0, 0.0]));
        assert_eq!(valid_location([f32::MAX, f32::MAX, f32::MAX]), None); // after a capture
        assert_eq!(valid_location([0.0, 0.0, 0.0]), None); // before the first rift
    }

    #[test]
    fn game_clock_excludes_pauses_and_the_pre_game() {
        let clock = Clock { net_tick: 64 * 100, tick_interval: Some(1.0 / 64.0), game_start: Some(20.0), paused: false, total_paused_ticks: 64 * 10 };
        assert_eq!(clock.game_time(), Some(70.0));
        assert_eq!(Clock::default().game_time(), None);
    }
}
