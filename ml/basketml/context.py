"""Pre-game context computed strictly from EARLIER matches (no leakage).

For every match, before it is played:

  lg_recent  exponentially weighted mean of the regulation total in the same league
             (half-life `league_half_life` matches). Tracks the scoring trend —
             EuroLeague regulation totals rose from 153 (2021-22) to 173 (2026-27).
  team_dev   sum of both teams' "total tendency": each team's exponentially weighted mean
             of (regulation total − lg_recent) in its earlier games, shrunk towards 0 by
             n / (n + team_prior_games). Positive = these teams usually play high-scoring games.

Matches that start at the same timestamp see the same state (none of them sees another's
result). Both values are NaN until enough history exists.
"""
from __future__ import annotations

import math
from itertools import groupby

import numpy as np

from .data import Match
from .features import league_key


def pregame_context(matches: list[Match], league_half_life: float = 150, team_half_life: float = 12,
                    team_prior_games: float = 6, min_league_matches: int = 20,
                    return_state: bool = False):
    """Per-match context {id: {lg_recent, team_dev}}. With return_state=True also returns the
    state after the last match, i.e. what the live app needs for the NEXT match:
    {"leagues": {key: {"mean", "n"}}, "teams": {key: {name: {"dev", "n", "last"}}}}."""
    a_lg = 1 - 0.5 ** (1 / league_half_life)
    a_tm = 1 - 0.5 ** (1 / team_half_life)
    lg_mean: dict[str, float] = {}
    lg_n: dict[str, int] = {}
    tm_dev: dict[tuple, float] = {}
    tm_n: dict[tuple, int] = {}
    tm_last: dict[tuple, str] = {}
    out: dict[str, dict] = {}

    def team_value(key):
        n = tm_n.get(key, 0)
        return tm_dev[key] * n / (n + team_prior_games) if n else 0.0

    ordered = sorted(matches, key=lambda m: m.recorded_at)
    for _, group in groupby(ordered, key=lambda m: m.recorded_at):
        group = list(group)
        for m in group:                       # 1) read state for the whole time slot
            lk = league_key(m.league)
            n = lg_n.get(lk, 0)
            lg = lg_mean[lk] if n >= min_league_matches else float("nan")
            h, a = (lk, m.meta.get("home") or ""), (lk, m.meta.get("away") or "")
            known = bool(h[1] and a[1])
            out[m.id] = {
                "lg_recent": lg,
                "team_dev": team_value(h) + team_value(a) if known and not math.isnan(lg) else float("nan"),
            }
        for m in group:                       # 2) then learn from their results
            reg = m.regulation_total
            if not np.isfinite(reg):
                continue
            lk = league_key(m.league)
            prev = lg_mean.get(lk)
            if prev is not None and lg_n[lk] >= min_league_matches:
                for side in ("home", "away"):
                    name = m.meta.get(side) or ""
                    if not name:
                        continue
                    key = (lk, name)
                    dev = reg - prev
                    tm_dev[key] = dev if key not in tm_dev else tm_dev[key] + a_tm * (dev - tm_dev[key])
                    tm_n[key] = tm_n.get(key, 0) + 1
                    tm_last[key] = m.recorded_at
            n = lg_n.get(lk, 0)
            # plain mean while the league is young, EWMA afterwards
            lg_mean[lk] = reg if prev is None else prev + max(a_lg, 1 / (n + 1)) * (reg - prev)
            lg_n[lk] = n + 1
    if not return_state:
        return out
    state = {"leagues": {k: {"mean": lg_mean[k], "n": lg_n[k]} for k in lg_mean
                         if lg_n[k] >= min_league_matches},
             "teams": {}}
    for (lk, name), n in tm_n.items():
        state["teams"].setdefault(lk, {})[name] = {
            "dev": team_value((lk, name)), "n": n, "last": tm_last[(lk, name)]}
    return out, state
