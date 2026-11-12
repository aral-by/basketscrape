// src/euroleagueLive.js: game matching, box score summary, team fouls/bonus, and the manager's polling.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EuroleagueLive, summarize, matchGame, competitionOf, seasonCode, displayName, foulsInPeriod } = require('../src/euroleagueLive');
const { MatchManager } = require('../src/matchManager');

const club = (name, abbr, code) => ({ code, name, abbreviatedName: abbr, editorialName: abbr });
const GAMES = [
  { gameCode: 13, season: { code: 'E2025' }, utcDate: '2025-10-02T18:30:00Z', local: { club: club('Real Madrid', 'Real Madrid', 'MAD') }, road: { club: club('Olympiacos Piraeus', 'Olympiacos', 'OLY') } },
  { gameCode: 14, season: { code: 'E2025' }, utcDate: '2025-10-02T18:30:00Z', local: { club: club('Fenerbahce Beko Istanbul', 'Fenerbahce', 'ULK') }, road: { club: club('FC Barcelona', 'Barcelona', 'BAR') } },
  { gameCode: 90, season: { code: 'E2025' }, utcDate: '2025-12-20T18:30:00Z', local: { club: club('Real Madrid', 'Real Madrid', 'MAD') }, road: { club: club('Olympiacos Piraeus', 'Olympiacos', 'OLY') } },
];

test('competition and season come from the Flashscore league and the date', () => {
  assert.equal(competitionOf('EUROPE: Euroleague - Round 9'), 'E');
  assert.equal(competitionOf('EUROPE: EuroCup - Play Offs'), 'U');
  assert.equal(competitionOf('USA: NBA'), null);
  assert.equal(seasonCode('E', new Date('2026-11-12T00:00:00Z')), 'E2026');
  assert.equal(seasonCode('E', new Date('2027-04-16T00:00:00Z')), 'E2026');
});

test('the official game is found by date and team names, also when home/away are swapped', () => {
  const date = new Date('2025-10-02T19:15:00Z');
  const g = matchGame(GAMES, { homeName: 'Real Madrid', awayName: 'Olympiacos', date });
  assert.deepEqual([g.gameCode, g.swapped], [13, false]);
  const s = matchGame(GAMES, { homeName: 'Barcelona', awayName: 'Fenerbahçe', date });
  assert.deepEqual([s.gameCode, s.swapped], [14, true]);
  assert.equal(matchGame(GAMES, { homeName: 'Real Madrid', awayName: 'Olympiacos', date: new Date('2025-11-10T00:00:00Z') }), null);
  assert.equal(matchGame(GAMES, { homeName: 'Unknown', awayName: 'Olympiacos', date }), null);
});

function P(name, team, extra = {}) {
  return { Player_ID: 'P1', Team: team, Dorsal: '7', Player: name, IsStarter: 1, IsPlaying: 1, Minutes: '20:30',
    Points: 10, FieldGoalsMade2: 2, FieldGoalsAttempted2: 4, FieldGoalsMade3: 2, FieldGoalsAttempted3: 5,
    FreeThrowsMade: 0, FreeThrowsAttempted: 0, OffensiveRebounds: 1, DefensiveRebounds: 3, TotalRebounds: 4,
    Assistances: 2, Steals: 1, Turnovers: 1, BlocksFavour: 0, BlocksAgainst: 0, FoulsCommited: 3, FoulsReceived: 2,
    Valuation: 9, Plusminus: 5, ...extra };
}
const BOX = {
  Live: true, Referees: 'A, B', Attendance: 1000,
  Stats: [
    { Team: 'REAL MADRID', Coach: 'SCARIOLO, SERGIO', PlayersStats: [P('LYLES, TREY', 'MAD')], totr: P('', 'MAD'), tmr: { TotalRebounds: 3 } },
    { Team: 'OLYMPIACOS PIRAEUS', Coach: 'BARTZOKAS, GEORGIOS', PlayersStats: [P('VEZENKOV, SASHA', 'OLY', { FoulsCommited: 5 })], totr: P('', 'OLY'), tmr: { TotalRebounds: 1 } },
  ],
};
const ev = (n, minute, team, type, a = null, b = null) => ({ NUMBEROFPLAY: n, MINUTE: minute, MARKERTIME: '05:00', CODETEAM: team, PLAYER_ID: team ? 'P1' : '', PLAYER: team ? 'LYLES, TREY' : '', PLAYTYPE: type, PLAYINFO: type, POINTS_A: a, POINTS_B: b });
const PBP = {
  CodeTeamA: 'MAD', CodeTeamB: 'OLY',
  FirstQuarter: [ev(1, 1, 'MAD', '2FGM', 2, 0), ev(2, 3, 'OLY', 'CM'), ev(3, 4, 'OLY', 'CM')],
  SecondQuarter: [ev(4, 12, 'MAD', 'CM'), ev(5, 13, 'MAD', 'CM'), ev(6, 14, 'MAD', 'OF'), ev(7, 15, 'MAD', 'CMU'), ev(8, 16, 'MAD', 'CM'), ev(9, 17, 'MAD', 'TOUT')],
  ThirdQuarter: [], ForthQuarter: [ev(10, 39, 'OLY', 'CM'), ev(11, 39, 'OLY', 'CM'), ev(12, 40, 'OLY', 'CM'), ev(13, 40, 'OLY', 'CM')],
  ExtraTime: [ev(14, 41, 'OLY', 'CM', 80, 80)],
};

test('box score: players, team fouls per period, bonus and the newest events first', () => {
  const b = summarize(BOX, PBP, { uptoMinute: 17 });
  assert.equal(b.home.name, 'Real Madrid');
  assert.equal(b.home.coach, 'Sergio Scariolo');
  const p = b.home.players[0];
  assert.deepEqual([p.name, p.min, p.pts, p.pf, p.pir, p.pm, p.onCourt], ['Trey Lyles', 20.5, 10, 3, 9, 5, true]);
  assert.equal(b.period, 2);
  assert.deepEqual(b.home.fouls.byPeriod, [0, 5, 0, 0]);
  assert.equal(b.home.fouls.current, 5);
  assert.equal(b.home.fouls.bonus, true, 'more than 4 team fouls → bonus');
  assert.equal(b.away.fouls.current, 0, 'Q1 fouls do not count in Q2');
  assert.equal(b.events[0].text, 'Mola');
  assert.equal(b.events.at(-1).score, '2-0');
  assert.ok(b.events.every((e) => e.minute <= 17));
});

test('overtime continues the fourth-quarter foul count', () => {
  const b = summarize(BOX, PBP);
  assert.equal(b.period, 5);
  assert.deepEqual(b.away.fouls.byPeriod, [2, 0, 0, 4, 1]);
  assert.equal(b.away.fouls.current, 5);
  assert.equal(foulsInPeriod([1, 2, 3, 4], 2), 3);
});

test('swapped games are turned around to Flashscore home/away', () => {
  const b = summarize(BOX, PBP, { swapped: true, uptoMinute: 2 });
  assert.equal(b.home.name, 'Olympiacos Piraeus');
  assert.equal(b.events[0].side, 'away');
  assert.equal(b.events[0].score, '0-2');
  assert.equal(displayName("O'NEALE, ROYCE"), "Royce O'Neale");
});

test('the match manager finds the game once, polls it and stops when the match ends', async () => {
  const calls = { find: 0, fetch: 0 };
  const official = new EuroleagueLive({
    now: () => new Date('2025-10-02T19:00:00Z'),
    fetchJson: async (url) => {
      if (url.includes('/games')) { calls.find++; return { data: GAMES }; }
      calls.fetch++;
      return url.includes('Boxscore') ? BOX : PBP;
    },
  });
  const events = [];
  const watchers = [];
  const m = new MatchManager({
    startWatcher: (url, onUpdate, onEnd) => { const w = { onUpdate, onEnd, stop() {} }; watchers.push(w); return w; },
    emit: (e, p) => events.push([e, p]), official, officialEveryMs: 10,
  });
  const { id } = m.add('https://www.flashscore.com/match/basketball/AAAAAAAA/').session;
  const st = { homeMinutes: [2], awayMinutes: [0], totalCells: 40, lastAbsoluteMinute: 1, homeScore: 2, awayScore: 0,
    league: 'EUROPE: Euroleague - Round 2', homeName: 'Real Madrid', awayName: 'Olympiacos' };
  watchers[0].onUpdate(st);
  watchers[0].onUpdate(st);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.find, 1, 'schedule fetched once (cached)');
  const box = events.filter(([e]) => e === 'match:box');
  assert.ok(box.length >= 2, 'polled repeatedly');
  assert.equal(box[0][1].id, id);
  assert.equal(m.list()[0].box.home.name, 'Real Madrid');
  watchers[0].onEnd({ reason: 'finished', final: { home: 80, away: 70 } });
  await new Promise((r) => setTimeout(r, 30));
  const n = events.filter(([e]) => e === 'match:box').length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(events.filter(([e]) => e === 'match:box').length, n, 'no polling after the match ended');
});

test('leagues other than EuroLeague/EuroCup never call the official API', async () => {
  let called = 0;
  const official = new EuroleagueLive({ fetchJson: async () => { called++; return {}; } });
  const watchers = [];
  const m = new MatchManager({ startWatcher: (u, onUpdate) => { const w = { onUpdate, stop() {} }; watchers.push(w); return w; }, official });
  m.add('https://www.flashscore.com/match/basketball/BBBBBBBB/');
  watchers[0].onUpdate({ homeMinutes: [], awayMinutes: [], lastAbsoluteMinute: 1, homeScore: 0, awayScore: 0, league: 'TURKEY: Super Lig', homeName: 'A', awayName: 'B' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, 0);
});
