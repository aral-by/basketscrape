// public/analysis-views.js: calculations behind the detailed analysis views.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calc } = require('../public/analysis-views');

function state(cellsH, cellsA, extra = {}) {
  const n = cellsH.length;
  const pad = (c) => [...c, ...new Array(Math.max(0, 40 - n)).fill(0)];
  const sum = (c) => c.reduce((x, y) => x + y, 0);
  return { homeMinutes: pad(cellsH), awayMinutes: pad(cellsA), totalCells: 40, lastAbsoluteMinute: n,
    homeScore: sum(cellsH), awayScore: sum(cellsA), ...extra };
}

test('cumulative scores are anchored to the live score (mid-match join)', () => {
  // joined in minute 3 at 20-18: cells before are 0
  const s = state([0, 0, 0, 2, 0], [0, 0, 0, 0, 3], { homeScore: 22, awayScore: 21 });
  const sr = calc.series(s);
  assert.deepEqual(sr.cumH, [20, 20, 20, 22, 22]);
  assert.deepEqual(sr.cumA, [18, 18, 18, 18, 21]);
  assert.deepEqual(sr.margin, [2, 2, 2, 4, 1]);
});

test('EG10 restarts each quarter and uses the 0.7 rounding rule', () => {
  const h = new Array(12).fill(1);
  const s = state(h, new Array(12).fill(1));
  const sr = calc.series(s);
  assert.equal(sr.eg10[0], 80);        // 2 pts in 1 min → ×40
  assert.equal(sr.eg10[10], 80);       // minute 11 = first of Q2: restarts
  assert.equal(calc.roundEg10(10.69), 10);
  assert.equal(calc.roundEg10(10.7), 11);
});

test('lead changes, ties, largest leads, runs and droughts', () => {
  //            m1 m2 m3 m4 m5 m6 m7
  const h =    [2, 0, 0, 0, 3, 0, 2];
  const a =    [0, 3, 2, 0, 0, 2, 2];
  const sr = calc.series(state(h, a));
  const f = calc.flowStats(sr, sr.L);
  // margins: 2, -1, -3, -3, 0, -2, -2
  assert.equal(f.leadChanges, 1);
  assert.equal(f.ties, 1);
  assert.deepEqual([f.maxH.v, f.maxH.m], [2, 1]);
  assert.deepEqual([f.maxA.v, f.maxA.m], [3, 3]);
  assert.equal(f.runs.away.pts, 5);    // 3 + 2 in minutes 2-3 (minute 4 scoreless keeps it open)
  assert.equal(f.droughtH.len, 3);     // minutes 2-4
});

test('statistics: the most specific keyword wins', () => {
  const flat = calc.flatStats([{ rows: [
    { name: 'Hücum Ribaundu', home: '9', away: '7' },
    { name: 'Toplam Ribaund', home: '35', away: '30' },
    { name: 'Alan Golü', home: '30/60', away: '25/58' },
    { name: 'Üç Sayılık', home: '10/25', away: '8/24' },
    { name: 'Serbest Atış', home: '12/15', away: '20/24' },
    { name: 'Fauller', home: '18', away: '21' },
  ] }]);
  assert.equal(calc.findStat(flat, 'toplam rib', 'total reb').home.made, 35);
  const tm = calc.teamMetrics([{ rows: [
    { name: 'Alan Golü', home: '30/60', away: '25/58' },
    { name: 'Üç Sayılık', home: '10/25', away: '8/24' },
    { name: 'Serbest Atış', home: '12/15', away: '20/24' },
    { name: 'Fauller', home: '18', away: '21' },
  ] }], 82, 78);
  assert.equal(tm.raw.home.fg2m, 20);
  assert.ok(Math.abs(tm.home.efg - (30 + 5) / 60) < 1e-9);
  assert.ok(Math.abs(tm.home.ts - 82 / (2 * (60 + 0.44 * 15))) < 1e-9);
  assert.equal(tm.raw.away.pf, 21);
  assert.equal(tm.hasFouls, true);
});

test('quarter table marks the quarter in progress', () => {
  const s = state(new Array(13).fill(2), new Array(13).fill(1));
  const q = calc.quarterTable(s, calc.series(s));
  assert.equal(q.length, 2);
  assert.deepEqual([q[0].h, q[0].a, q[0].done], [20, 10, true]);
  assert.deepEqual([q[1].played, q[1].done], [3, false]);
});
