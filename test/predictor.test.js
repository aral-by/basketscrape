const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { Predictor, probOver, completedMinutes, leagueKey, interpTable } = require('../src/predictor');
const { LiveForecast, loadPredictor } = require('../src/liveForecast');

const MODEL = JSON.parse(fs.readFileSync(path.join(__dirname, '../models/eb_plus.json'), 'utf8'));
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/predictor_parity.json'), 'utf8'));
const P = new Predictor(MODEL);

test('JS port matches the Python model on 200 exported cases', () => {
  for (const c of CASES) {
    const p = P.predict({ ...c, line: null });   // c.line is the over/under line, not a pregame prior
    assert.ok(Math.abs(p.mean - c.mean) < 1e-6, `mean t=${c.t}: ${p.mean} vs ${c.mean}`);
    assert.ok(Math.abs(p.sd - c.sd) < 1e-6, `sd t=${c.t}`);
    assert.ok(Math.abs(p.pOT - c.pOT) < 1e-9, `pOT t=${c.t}`);
    assert.ok(Math.abs(probOver(p.mix, c.line) - c.pOver) < 1e-6, `pOver t=${c.t}`);
  }
});

test('league names from Flashscore and the API resolve to the same model league', () => {
  assert.equal(leagueKey('EUROLEAGUE 2023-24'), 'euroleague');
  assert.equal(P.resolveLeague('BasketballEuropeEuroleague - Round 11'), 'euroleague');
  assert.equal(P.resolveLeague('EUROPE: EuroCup - Play Offs'), 'eurocup');
  assert.equal(P.resolveLeague('USA: NBA'), null);
});

test('live team names are matched to the most recent model team', () => {
  const fb = P.resolveTeam('euroleague', 'Fenerbahçe');
  assert.ok(fb && /FENERBAHCE/.test(fb.name));
  const all = Object.entries(MODEL.context.teams.euroleague).filter(([n]) => n.includes('FENERBAHCE'));
  const newest = all.sort((a, b) => (a[1].last < b[1].last ? 1 : -1))[0][0];
  assert.equal(fb.name, newest);
  assert.equal(P.resolveTeam('euroleague', 'Totally Unknown Club'), null);
  const ctx = P.context('Euroleague', 'Real Madrid', 'Unknown Club');
  assert.equal(ctx.league, 'euroleague');
  assert.equal(ctx.teamDev, ctx.home.dev);
});

test('probabilities are valid and the 80 % band is mean ± 1.2816·sd', () => {
  const p = P.predict({ t: 28, S: 115, margin: 2, league: 'euroleague' });
  assert.ok(Math.abs(p.hi80 - p.mean - 1.2815515655446004 * p.sd) < 1e-9);
  let prev = 1;
  for (let L = 120; L <= 220; L += 5) {
    const q = probOver(p.mix, L);
    assert.ok(q >= 0 && q <= 1 && q <= prev + 1e-12);
    prev = q;
  }
  assert.ok(probOver(p.mix, p.mean) < 0.5, 'overtime tail → right skew');
  assert.equal(probOver(p.mix, NaN), null);
  assert.equal(P.predict({ t: 40, S: 160 }), null);
  assert.equal(P.predict({ t: 0, S: 0 }), null);
});

test('close games carry a higher overtime probability than blowouts', () => {
  const close = P.predict({ t: 36, S: 140, margin: 1, league: 'euroleague' });
  const blow = P.predict({ t: 36, S: 140, margin: 20, league: 'euroleague' });
  assert.ok(close.pOT > 5 * blow.pOT);
});

test('interpTable behaves like numpy.interp', () => {
  const tab = { 10: 1, 20: 3 };
  assert.equal(interpTable(tab, 5), 1);
  assert.equal(interpTable(tab, 15), 2);
  assert.equal(interpTable(tab, 30), 3);
});

function state(cells, { home, away } = {}, extra = {}) {
  const homeMinutes = cells.map((c) => c[0]);
  const awayMinutes = cells.map((c) => c[1]);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    homeMinutes, awayMinutes, totalCells: 40, lastAbsoluteMinute: cells.length,
    homeScore: home ?? sum(homeMinutes), awayScore: away ?? sum(awayMinutes),
    league: 'EUROPE: Euroleague', homeName: 'Real Madrid', awayName: 'Barcelona', ...extra,
  };
}

test('completed minutes exclude the minute in progress and use end-of-minute scores', () => {
  const s = state([[2, 0], [0, 3], [5, 1]]);
  const out = completedMinutes(s);
  assert.deepEqual(out.map((x) => [x.t, x.home, x.away]), [[1, 2, 0], [2, 2, 3]]);
});

test('mid-match join: minutes before the first observed one are not reconstructed', () => {
  // joined in minute 3 at 20-18 (baseline), cells of minutes 1-3 are 0
  const s = state([[0, 0], [0, 0], [0, 0], [2, 0], [0, 2]], { home: 22, away: 20 });
  const out = completedMinutes(s, 3);
  assert.deepEqual(out.map((x) => [x.t, x.home, x.away]), [[3, 20, 18], [4, 22, 18]]);
});

test('live forecast locks once in the lock window and keeps the lock', () => {
  const f = new LiveForecast(P);
  const cells = [];
  let lockedAt = null;
  for (let m = 1; m <= 40; m++) {
    cells.push([2, 2]);
    const out = f.update(state(cells.slice(), {}, {}));
    assert.equal(out.available, true);
    if (out.lock && lockedAt === null) lockedAt = m - 1;
  }
  const rule = MODEL.lock_rule;
  assert.ok(lockedAt >= rule.from && lockedAt <= rule.to, `locked at ${lockedAt}`);
  const lock = f.last.lock;
  assert.equal(lock.t, lockedAt);
  assert.equal(f.last.history.length, 39);
  const done = f.finish({ final: { home: 80, away: 80 } });
  assert.equal(done.final, 160);
  assert.equal(done.lockError, Math.round((160 - lock.mean) * 10) / 10);
  assert.equal(f.last.context.trained, true);
  assert.equal(f.last.context.home !== null, true);
});

test('missing model file disables predictions without throwing', () => {
  assert.equal(loadPredictor('/nonexistent/model.json'), null);
  const f = new LiveForecast(null);
  assert.equal(f.update(state([[1, 1]])).available, false);
  assert.deepEqual(f.info(), { available: false });
});

test('leagues the model was not validated on get no prediction', () => {
  const f = new LiveForecast(P);
  const out = f.update(state([[2, 2], [2, 2], [2, 2]], {}, { league: 'USA: NBA' }));
  assert.equal(out.available, false);
  assert.equal(out.unsupported, true);
  assert.deepEqual(out.supported, ['eurocup', 'euroleague']);
  assert.ok(f.update(state([[2, 2], [2, 2], [2, 2]], {}, { league: 'EUROPE: EuroCup' })).available);
});
