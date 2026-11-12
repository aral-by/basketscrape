// Official EuroLeague / EuroCup live data for a watched match: player box score, team fouls per
// period (bonus) and the latest play-by-play events.
//
//   schedule  https://api-live.euroleague.net/v2/competitions/{E|U}/seasons/{E2026}/games
//   box score https://live.euroleague.net/api/Boxscore?gamecode=N&seasoncode=E2026
//   plays     https://live.euroleague.net/api/PlayByPlay?gamecode=N&seasoncode=E2026
//
// A Flashscore match is matched to the official game by date (±36 h) and team names.
'use strict';

const SCHEDULE = 'https://api-live.euroleague.net/v2/competitions';
const LIVE = 'https://live.euroleague.net/api';
const UA = { 'User-Agent': 'basketscrape/1.0' };

// FIBA: every player foul counts as a team foul; from the 5th team foul of a period the
// opponent shoots free throws ("bonus"). Overtimes continue the 4th-quarter count.
const FOUL_TYPES = new Set(['CM', 'OF', 'CMU', 'CMT', 'CMD', 'CMTI', 'B']);
const BONUS_AT = 4;   // after 4 team fouls

const FOLD = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'İ': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'é': 'e', 'è': 'e', 'á': 'a',
  'ó': 'o', 'í': 'i', 'ú': 'u', 'ñ': 'n', 'ž': 'z', 'š': 's', 'č': 'c', 'ć': 'c', 'ä': 'a', 'ë': 'e' };
const STOP = new Set(['basketball', 'basket', 'club', 'bc', 'kk', 'fc', 'bk', 'sad', 'the']);

function tokens(name) {
  return String(name || '').toLowerCase().replace(/./g, (c) => FOLD[c] || c)
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

function nameScore(live, ...official) {
  const want = tokens(live);
  if (!want.length) return 0;
  const have = new Set(official.flatMap(tokens));
  return want.filter((w) => have.has(w)).length / want.length;
}

/** "EUROPE: Euroleague - Round 9" → 'E', EuroCup → 'U', anything else → null */
function competitionOf(league) {
  const k = String(league || '').toLowerCase().replace(/[^a-z]/g, '');
  if (k.includes('eurocup')) return 'U';
  if (k.includes('euroleague')) return 'E';
  return null;
}

/** Season code for a date: seasons start in July (E2026 = 2026-27). */
function seasonCode(comp, date = new Date()) {
  const y = date.getUTCFullYear() - (date.getUTCMonth() < 6 ? 1 : 0);
  return `${comp}${y}`;
}

/** Best official game for a live match, or null. `swapped` = Flashscore home is the official road team. */
function matchGame(games, { homeName, awayName, date = new Date() }) {
  let best = null;
  for (const g of games || []) {
    const t = Date.parse(g.utcDate || g.date);
    if (!isFinite(t) || Math.abs(t - date.getTime()) > 36 * 3600e3) continue;
    const L = g.local && g.local.club, R = g.road && g.road.club;
    if (!L || !R) continue;
    const names = (c) => [c.name, c.abbreviatedName, c.editorialName, c.code];
    // both teams must match (at least half of each live name's words)
    const pair = (x, y) => {
      const a = nameScore(homeName, ...names(x)), b = nameScore(awayName, ...names(y));
      return a >= 0.5 && b >= 0.5 ? a + b : 0;
    };
    const straight = pair(L, R);
    const swapped = pair(R, L);
    const score = Math.max(straight, swapped);
    if (score > 0 && (!best || score > best.score)) {
      best = { score, gameCode: g.gameCode, season: g.season && g.season.code, swapped: swapped > straight,
        home: (swapped > straight ? R : L).name, away: (swapped > straight ? L : R).name };
    }
  }
  return best;
}

const PERIOD_KEYS = ['FirstQuarter', 'SecondQuarter', 'ThirdQuarter', 'ForthQuarter', 'ExtraTime'];

const PLAY_TR = {
  '2FGM': 'İki sayılık', '3FGM': 'Üç sayılık', FTM: 'Serbest atış', '2FGA': 'Kaçan iki', '3FGA': 'Kaçan üç',
  FTA: 'Kaçan serbest atış', D: 'Savunma ribaundu', O: 'Hücum ribaundu', AS: 'Asist', ST: 'Top çalma',
  TO: 'Top kaybı', FV: 'Blok', AG: 'Bloklanan şut', CM: 'Faul', OF: 'Hücum faulü', CMU: 'Sportmenlik dışı faul',
  CMT: 'Teknik faul', CMD: 'Diskalifiye edici faul', RV: 'Faul aldı', TOUT: 'Mola', TOUT_TV: 'TV molası',
  IN: 'Oyuna girdi', OUT: 'Oyundan çıktı', BP: 'Periyot başladı', EP: 'Periyot bitti', EG: 'Maç bitti', JB: 'Hava atışı',
  CCH: 'Koç itirazı',
};

const clean = (s) => String(s == null ? '' : s).trim();

function displayName(raw) {
  // "LYLES, TREY" → "Trey Lyles"
  const s = clean(raw);
  if (!s.includes(',')) return titleCase(s);
  const [last, first] = s.split(',').map((x) => x.trim());
  return titleCase(`${first} ${last}`);
}
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

function minutesToNum(m) {
  if (!m || typeof m !== 'string' || !m.includes(':')) return 0;
  const [a, b] = m.split(':').map(Number);
  return (a || 0) + (b || 0) / 60;
}

function player(p) {
  return {
    no: clean(p.Dorsal), name: displayName(p.Player), starter: !!p.IsStarter, onCourt: !!p.IsPlaying,
    min: minutesToNum(p.Minutes), minText: clean(p.Minutes) || '—',
    pts: p.Points | 0, fg2m: p.FieldGoalsMade2 | 0, fg2a: p.FieldGoalsAttempted2 | 0,
    fg3m: p.FieldGoalsMade3 | 0, fg3a: p.FieldGoalsAttempted3 | 0, ftm: p.FreeThrowsMade | 0, fta: p.FreeThrowsAttempted | 0,
    oreb: p.OffensiveRebounds | 0, dreb: p.DefensiveRebounds | 0, reb: p.TotalRebounds | 0,
    ast: p.Assistances | 0, stl: p.Steals | 0, tov: p.Turnovers | 0, blk: p.BlocksFavour | 0, blka: p.BlocksAgainst | 0,
    pf: p.FoulsCommited | 0, fd: p.FoulsReceived | 0, pir: p.Valuation | 0, pm: p.Plusminus == null ? null : p.Plusminus | 0,
  };
}

/** Team fouls per period from play-by-play, plus the latest events (newest first). */
function playSummary(pbp, codeA, uptoMinute = Infinity) {
  const fouls = { A: [], B: [] };
  const events = [];
  let period = 0;
  let sa = 0, sb = 0;   // running score, carried onto events without one
  PERIOD_KEYS.forEach((key, i) => {
    for (const e of (pbp && pbp[key]) || []) {
      const minute = e.MINUTE | 0;
      if (minute > uptoMinute) continue;
      const p = i < 4 ? i : 3 + Math.max(1, Math.ceil((minute - 40) / 5));   // OT periods: 4, 5, …
      period = Math.max(period, p + 1);
      const side = clean(e.CODETEAM) ? (clean(e.CODETEAM) === clean(codeA) ? 'A' : 'B') : null;
      const type = clean(e.PLAYTYPE);
      if (side && FOUL_TYPES.has(type) && clean(e.PLAYER_ID)) {
        fouls[side][p] = (fouls[side][p] || 0) + 1;
      }
      if (e.POINTS_A != null && e.POINTS_B != null) { sa = e.POINTS_A; sb = e.POINTS_B; }
      if (type === 'IN' || type === 'OUT') continue;
      events.push({
        n: e.NUMBEROFPLAY, minute, clock: clean(e.MARKERTIME), side, type,
        text: PLAY_TR[type] || clean(e.PLAYINFO), player: e.PLAYER ? displayName(e.PLAYER) : '',
        scoreA: sa, scoreB: sb, scoring: e.POINTS_A != null && /FGM|FTM/.test(type),
      });
    }
  });
  events.sort((x, y) => (y.n || 0) - (x.n || 0));
  return { fouls, events: events.slice(0, 25), period };
}

/** Team fouls that count in `period` (0-based); overtimes continue the 4th quarter. */
function foulsInPeriod(list, period) {
  if (period < 4) return list[period] || 0;
  let n = list[3] || 0;
  for (let p = 4; p <= period; p++) n += list[p] || 0;
  return n;
}

/** Box score + plays → payload for the panel, oriented to Flashscore's home/away. */
function summarize(box, pbp, { swapped = false, uptoMinute = Infinity, demo = false } = {}) {
  const stats = (box && box.Stats) || [];
  if (stats.length < 2) return null;
  const [A, B] = stats;
  const codeA = clean(A.PlayersStats && A.PlayersStats[0] && A.PlayersStats[0].Team) || clean(pbp && pbp.CodeTeamA);
  const plays = playSummary(pbp, codeA, uptoMinute);
  const team = (t, side) => {
    const players = (t.PlayersStats || []).map(player);
    const totals = t.totr ? player({ ...t.totr, Player: 'Toplam' }) : null;
    const tf = plays.fouls[side];
    const cur = Math.max(0, plays.period - 1);
    const inPeriod = foulsInPeriod(tf, cur);
    return {
      name: titleCase(clean(t.Team)), coach: displayName(t.Coach), players, totals,
      teamReb: t.tmr ? (t.tmr.TotalRebounds | 0) : 0,
      fouls: { byPeriod: Array.from({ length: Math.max(4, plays.period) }, (_, i) => tf[i] || 0),
        current: inPeriod, bonus: inPeriod >= BONUS_AT },
    };
  };
  let home = team(A, 'A'), away = team(B, 'B');
  const events = plays.events.map((e) => ({ ...e, side: e.side === 'A' ? 'home' : e.side === 'B' ? 'away' : null,
    score: e.scoreA != null ? `${e.scoreA}-${e.scoreB}` : null }));
  if (swapped) {
    [home, away] = [away, home];
    events.forEach((e) => {
      e.side = e.side === 'home' ? 'away' : e.side === 'away' ? 'home' : null;
      if (e.score) e.score = e.score.split('-').reverse().join('-');
    });
  }
  return { source: 'euroleague', demo, live: !!(box && box.Live), period: plays.period, home, away, events,
    referees: clean(box && box.Referees), attendance: box && box.Attendance };
}

class EuroleagueLive {
  constructor({ fetchJson, now = () => new Date() } = {}) {
    this.fetchJson = fetchJson || defaultFetchJson;
    this.now = now;
    this.schedules = new Map();   // season → { at, games }
    this.raw = new Map();         // demo replays: box score + plays downloaded once
  }

  async schedule(comp, season) {
    const c = this.schedules.get(season);
    if (c && this.now() - c.at < 6 * 3600e3) return c.games;
    const d = await this.fetchJson(`${SCHEDULE}/${comp}/seasons/${season}/games`);
    const games = (d && d.data) || [];
    this.schedules.set(season, { at: this.now(), games });
    return games;
  }

  /** Finds the official game for a live match; null if the league is not EuroLeague/EuroCup or no match. */
  async find({ league, homeName, awayName }) {
    const comp = competitionOf(league);
    if (!comp) return null;
    const date = this.now();
    // Around July both seasons can be relevant (late playoffs / early games).
    const seasons = [...new Set([seasonCode(comp, date), seasonCode(comp, new Date(date.getTime() - 60 * 86400e3))])];
    for (const season of seasons) {
      const g = matchGame(await this.schedule(comp, season), { homeName, awayName, date });
      if (g) return { ...g, season: g.season || season };
    }
    return null;
  }

  async fetch({ season, gameCode, swapped }, opts = {}) {
    const q = `gamecode=${gameCode}&seasoncode=${season}`;
    let raw = opts.demo ? this.raw.get(q) : null;
    if (!raw) {
      const [box, pbp] = await Promise.all([
        this.fetchJson(`${LIVE}/Boxscore?${q}`), this.fetchJson(`${LIVE}/PlayByPlay?${q}`),
      ]);
      raw = { box, pbp };
      if (opts.demo) this.raw.set(q, raw);   // a finished game never changes
    }
    return summarize(raw.box, raw.pbp, { swapped, ...opts });
  }
}

async function defaultFetchJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  return t.trim() ? JSON.parse(t) : null;
}

module.exports = { EuroleagueLive, summarize, playSummary, matchGame, competitionOf, seasonCode, tokens, displayName, foulsInPeriod };
