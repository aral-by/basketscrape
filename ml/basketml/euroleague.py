"""EuroLeague / EuroCup historical backfill from the public live-stats API.

Every scoring event in the official play-by-play carries the game minute and the running
score, so a finished game can be converted into exactly the same minute-level record that
src/recorder.js writes for live matches (schema 1).

    https://live.euroleague.net/api/Header?gamecode=N&seasoncode=E2023      date, final, quarters
    https://live.euroleague.net/api/PlayByPlay?gamecode=N&seasoncode=E2023  events with MINUTE

Season codes: E<year> = EuroLeague, U<year> = EuroCup (<year> = season start).

Each converted game is validated against the official header before it is kept:
  * cumulative score after minutes 10, 20, 30 and 40 must equal the official quarter scores
  * the last cumulative score must equal the official final score
Games that fail either check are skipped and counted.
"""
from __future__ import annotations

import gzip
import http.client
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

BASE = "https://live.euroleague.net/api"
QUARTER_KEYS = ["FirstQuarter", "SecondQuarter", "ThirdQuarter", "ForthQuarter"]
USER_AGENT = "basketscrape-research/1.0"


class Fetcher:
    """Polite JSON fetcher: fixed delay between requests, retries with backoff."""

    def __init__(self, delay: float = 0.35, retries: int = 4, timeout: float = 20):
        self.delay, self.retries, self.timeout = delay, retries, timeout
        self._last = 0.0
        self.requests = 0
        self.last_failed = False   # True when the last get() gave up on network errors

    def get(self, path: str, season: str, game: int):
        url = f"{BASE}/{path}?gamecode={game}&seasoncode={season}"
        self.last_failed = False
        for attempt in range(self.retries):
            wait = self.delay - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.requests += 1
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    body = r.read()
                return json.loads(body) if body.strip() else None
            except urllib.error.HTTPError as e:
                if e.code in (400, 404):
                    return None
            except (OSError, http.client.HTTPException, json.JSONDecodeError):
                # OSError covers URLError, timeouts and "connection reset by peer"
                pass
            time.sleep(2 ** attempt)
        self.last_failed = True
        return None


def _int(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _iso_date(header: dict) -> str:
    try:
        d = datetime.strptime(f"{header['Date']} {header.get('Hour', '').strip() or '00:00'}",
                              "%d/%m/%Y %H:%M")
        return d.strftime("%Y-%m-%dT%H:%M:00Z")
    except (KeyError, ValueError):
        return ""


@dataclass
class ConversionResult:
    record: dict | None
    reason: str = "ok"


def convert_game(season: str, game: int, header: dict, pbp: dict) -> ConversionResult:
    """Header + PlayByPlay → schema-1 record (or a reason why the game was skipped)."""
    if not header or not pbp:
        return ConversionResult(None, "missing")
    if header.get("Live") or pbp.get("Live"):
        return ConversionResult(None, "live")
    final_a, final_b = _int(header.get("ScoreA")), _int(header.get("ScoreB"))
    if final_a is None or final_b is None or final_a + final_b == 0:
        return ConversionResult(None, "not_played")

    events = []
    for key in QUARTER_KEYS + ["ExtraTime"]:
        events.extend(pbp.get(key) or [])
    scoring = [e for e in events
               if e.get("POINTS_A") is not None and e.get("POINTS_B") is not None and e.get("MINUTE")]
    if not scoring:
        return ConversionResult(None, "no_events")

    last_minute = max(40, max(int(e["MINUTE"]) for e in scoring))
    n_cells = 40 + 5 * max(0, -(-(last_minute - 40) // 5))   # ceil to whole overtimes
    end_of_minute: dict[int, tuple[int, int]] = {}
    for e in scoring:                       # events are chronological; last one per minute wins
        end_of_minute[int(e["MINUTE"])] = (int(e["POINTS_A"]), int(e["POINTS_B"]))

    home, away = [], []
    a = b = 0
    for m in range(1, n_cells + 1):        # complete play-by-play: no score event → unchanged
        if m in end_of_minute:
            a, b = end_of_minute[m]
        home.append(a)
        away.append(b)

    # Validation against the official header
    for q, minute in enumerate([10, 20, 30, 40], start=1):
        qa, qb = _int(header.get(f"ScoreQuarter{q}A")), _int(header.get(f"ScoreQuarter{q}B"))
        if qa is not None and qb is not None and (home[minute - 1], away[minute - 1]) != (qa, qb):
            return ConversionResult(None, "quarter_mismatch")
    if (home[-1], away[-1]) != (final_a, final_b):
        return ConversionResult(None, "final_mismatch")

    competition = (header.get("Competition") or season).strip()
    return ConversionResult({
        "schema": 1,
        "id": f"{season}-{game:03d}",
        "url": f"{BASE}/PlayByPlay?gamecode={game}&seasoncode={season}",
        "source": "euroleague-api",
        "league": competition,
        "phase": (header.get("Phase") or "").strip(),
        "homeName": (header.get("TeamA") or "").strip(),
        "awayName": (header.get("TeamB") or "").strip(),
        "recordedAt": _iso_date(header),
        "status": "finished",
        "observedMinutes": n_cells,
        "firstObservedMinute": 1,
        "cumulative": {"home": home, "away": away},
        "totalCells": n_cells,
        "overtimePeriods": (n_cells - 40) // 5,
        "regulation": {"home": home[39], "away": away[39]},
        "final": {"home": final_a, "away": final_b},
    })


@dataclass
class SeasonStats:
    season: str
    kept: int = 0
    skipped: dict = field(default_factory=dict)


def backfill_season(season: str, out_dir: Path, fetcher: Fetcher, max_misses: int = 15,
                    log=print) -> SeasonStats:
    """Walks gamecode 1, 2, … until `max_misses` consecutive codes have no game."""
    stats = SeasonStats(season)
    records, misses, game = [], 0, 0
    while misses < max_misses:
        game += 1
        header = fetcher.get("Header", season, game)
        outage = 0
        while header is None and fetcher.last_failed and outage < 5:
            # Network outage, not a missing game: wait and retry the same game code.
            outage += 1
            log(f"  {season}: network error at game {game}, retry {outage}/5 in 30 s")
            time.sleep(30)
            header = fetcher.get("Header", season, game)
        if not header or not header.get("TeamA"):
            misses += 1
            continue
        misses = 0
        pbp = fetcher.get("PlayByPlay", season, game)
        res = convert_game(season, game, header, pbp)
        if res.record:
            records.append(res.record)
            stats.kept += 1
        else:
            stats.skipped[res.reason] = stats.skipped.get(res.reason, 0) + 1
        if game % 50 == 0:
            log(f"  {season}: game {game}, kept {stats.kept}, skipped {stats.skipped}")

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{season}.jsonl.gz"
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    log(f"{season}: kept {stats.kept}, skipped {stats.skipped} → {path}")
    return stats
