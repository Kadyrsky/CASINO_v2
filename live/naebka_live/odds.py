"""Transparent heuristic pricing model (Technical Design: Odds Engine).

Deliberately simple and explainable — fewer silent failure modes than a learned model (Risk #11).
Inputs are only the normalized match state; outputs are decimal odds with the book margin applied.

* Match winner: logistic model on the net-worth share difference (weighted up as the game matures)
  plus the objective differential.
* Duration over/under: starts from the average game length and shortens or stretches it by how far
  ahead of or behind schedule the objectives are falling.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal

from naebka_live.events import MatchState

OBJECTIVES_PER_TEAM = 16
PRIOR_DURATION_MIN = 32.0
MIN_ODDS = Decimal("1.01")
MAX_ODDS = Decimal("50.00")
PROB_FLOOR = 0.02

# Model coefficients — tuned by hand against typical Deadlock games.
NET_WORTH_WEIGHT = 6.0
OBJECTIVE_WEIGHT = 0.18
DURATION_SPREAD_MIN = 4.0
PACE_WEIGHT = 1.2
OVERTIME_SCALE_MIN = 10.0


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _clamp(p: float) -> float:
    return min(1.0 - PROB_FLOOR, max(PROB_FLOOR, p))


def win_probability(state: MatchState) -> float:
    """Probability that team 0 (Hidden King) wins."""
    nw0, nw1 = state.net_worth
    share_diff = (nw0 - nw1) / max(1, nw0 + nw1)
    minutes = state.elapsed_s / 60.0
    maturity = min(1.0, 0.4 + minutes / 30.0)
    objective_diff = state.objectives_alive[0] - state.objectives_alive[1]
    logit = NET_WORTH_WEIGHT * share_diff * maturity + OBJECTIVE_WEIGHT * objective_diff
    return _clamp(_sigmoid(logit))


def expected_progress(minutes: float) -> float:
    """Share of objectives an average game has destroyed by this minute (accelerates late game)."""
    return min(1.0, math.pow(minutes / PRIOR_DURATION_MIN, 2.2))


def projected_duration_min(state: MatchState) -> float:
    """Average game length, shortened when objectives fall faster than schedule and stretched when slower."""
    minutes = state.elapsed_s / 60.0
    destroyed = max(OBJECTIVES_PER_TEAM - a for a in state.objectives_alive)
    progress = min(1.0, destroyed / OBJECTIVES_PER_TEAM)
    if minutes < PRIOR_DURATION_MIN:
        remaining = (PRIOR_DURATION_MIN - minutes) * (1.0 + PACE_WEIGHT * (expected_progress(minutes) - progress))
    else:
        remaining = OVERTIME_SCALE_MIN * (1.0 - progress)
    return min(90.0, minutes + max(1.5, remaining))


def over_probability(state: MatchState, line_min: float) -> float:
    return _clamp(_sigmoid((projected_duration_min(state) - line_min) / DURATION_SPREAD_MIN))


def to_odds(probabilities: list[float], margin: float) -> list[Decimal]:
    """Fair probabilities → decimal odds with the overround spread proportionally, rounded down."""
    total = sum(probabilities)
    out: list[Decimal] = []
    for p in probabilities:
        priced = (p / total) * (1.0 + margin)
        odds = Decimal(1.0 / priced).quantize(Decimal("0.01"), rounding=ROUND_DOWN)
        out.append(min(MAX_ODDS, max(MIN_ODDS, odds)))
    return out


@dataclass(frozen=True)
class MarketPrice:
    market_type: str
    odds: dict[str, Decimal]
    close: bool = False

    def to_json(self) -> dict[str, object]:
        return {"market_type": self.market_type, "odds": {k: float(v) for k, v in self.odds.items()}, "close": self.close}


DURATION_LINE_MIN = 30.0


def price_match(state: MatchState, margin: float) -> list[MarketPrice]:
    p0 = win_probability(state)
    winner = to_odds([p0, 1.0 - p0], margin)
    prices = [MarketPrice("match_winner", {"side1": winner[0], "side2": winner[1]})]

    if state.elapsed_s >= DURATION_LINE_MIN * 60:
        prices.append(MarketPrice("duration_over_under", {}, close=True))  # already decided: Over
    else:
        p_over = over_probability(state, DURATION_LINE_MIN)
        dur = to_odds([p_over, 1.0 - p_over], margin)
        prices.append(MarketPrice("duration_over_under", {"over": dur[0], "under": dur[1]}))
    return prices
