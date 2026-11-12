const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MatchManager } = require('../src/matchManager');
const { loadPredictor } = require('../src/liveForecast');

const URL1 = 'https://www.flashscore.com/match/basketball/AAAAAAAA/#/match-summary';
const URL2 = 'https://www.flashscore.com/match/basketball/BBBBBBBB/#/match-summary';
const URL3 = 'https://www.flashscore.com/match/basketball/CCCCCCCC/#/match-summary';

function fakeWatchers() {
  const started = [];
  const startWatcher = (url, onUpdate, onEnd, onLog, onStatus) => {
    const w = { url, onUpdate, onEnd, onLog, onStatus, stopped: false, stop() { this.stopped = true; } };
    started.push(w);
    return w;
  };
  return { started, startWatcher };
}

function manager(extra = {}) {
  const events = [];
  const fw = fakeWatchers();
  const m = new MatchManager({
    startWatcher: fw.startWatcher, emit: (e, p) => events.push([e, p]),
    predictor: loadPredictor(), maxMatches: 3, ...extra,
  });
  return { m, events, ...fw };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mm-'));

function state(minute, home, away, extra = {}) {
  const homeMinutes = new Array(40).fill(0);
  const awayMinutes = new Array(40).fill(0);
  homeMinutes[minute - 1] = home;
  awayMinutes[minute - 1] = away;
  return {
    homeMinutes, awayMinutes, totalCells: 40, lastAbsoluteMinute: minute,
    homeScore: home, awayScore: away, league: 'EUROPE: Euroleague',
    homeName: 'Real Madrid', awayName: 'Barcelona', period: 1, minute, ...extra,
  };
}

test('several matches are watched at once, each with its own watcher', () => {
  const { m, started } = manager();
  const a = m.add(URL1).session;
  const b = m.add(URL2).session;
  assert.notEqual(a.id, b.id);
  assert.equal(started.length, 2);
  assert.deepEqual(m.list().map((s) => s.id), [a.id, b.id]);
});

test('adding the same match twice does not start a second watcher', () => {
  const { m, started } = manager();
  const first = m.add(URL1);
  const again = m.add(URL1.replace('#/match-summary', '#/match-summary/match-statistics'));
  assert.equal(again.existed, true);
  assert.equal(again.session.id, first.session.id);
  assert.equal(started.length, 1);
});

test('the concurrent match limit is enforced', () => {
  const { m } = manager({ maxMatches: 2 });
  m.add(URL1);
  m.add(URL2);
  assert.throws(() => m.add(URL3), (e) => e.code === 'LIMIT');
});

test('events are tagged with the match id and produce a prediction', () => {
  const { m, events, started } = manager();
  const { id } = m.add(URL1).session;
  m.add(URL2);
  started[0].onStatus({ status: 'running' });
  started[0].onUpdate(state(3, 4, 2));
  const kinds = events.map(([e]) => e);
  assert.ok(kinds.includes('match:status') && kinds.includes('match:update') && kinds.includes('match:prediction'));
  const pred = events.find(([e]) => e === 'match:prediction')[1];
  assert.equal(pred.id, id);
  assert.equal(pred.prediction.available, true);
  const snap = m.list().find((s) => s.id === id);
  assert.equal(snap.status.status, 'running');
  assert.equal(snap.update.lastAbsoluteMinute, 3);
  assert.equal(m.list().find((s) => s.id !== id).update, null, 'other match untouched');
});

test('remove stops only that match and late callbacks are ignored', () => {
  const { m, events, started } = manager();
  const { id } = m.add(URL1).session;
  m.add(URL2);
  m.remove(id);
  assert.equal(started[0].stopped, true);
  assert.equal(started[1].stopped, false);
  const n = events.length;
  started[0].onUpdate(state(2, 2, 0));
  assert.equal(events.length, n, 'removed match emits nothing');
  assert.deepEqual(m.list().map((s) => s.id).includes(id), false);
});

test('a finished match stays on the list with its final result', () => {
  const { m, started } = manager();
  const { id } = m.add(URL1).session;
  started[0].onUpdate(state(3, 4, 2));
  started[0].onEnd({ reason: 'finished', final: { home: 80, away: 76 } });
  const snap = m.list()[0];
  assert.equal(snap.id, id);
  assert.equal(snap.end.reason, 'finished');
  assert.equal(snap.prediction.final, 156);
  // watching it again starts afresh
  m.add(URL1);
  assert.equal(started.length, 2);
});

test('active matches survive a restart; finished and removed ones do not', () => {
  const dir = tmp();
  const file = path.join(dir, 'sessions.json');
  const one = manager({ sessionsFile: file });
  one.m.add(URL1);
  const b = one.m.add(URL2).session.id;
  one.m.add(URL3);
  one.started[0].onEnd({ reason: 'finished', final: { home: 1, away: 0 } });
  one.m.remove(b);
  one.m.stopAll();   // server shutting down

  const two = manager({ sessionsFile: file });
  assert.equal(two.m.restore(), 1);
  assert.deepEqual(two.started.map((w) => w.url), [URL3]);
});

test('restore copes with a missing or broken sessions file', () => {
  const dir = tmp();
  assert.equal(manager({ sessionsFile: path.join(dir, 'none.json') }).m.restore(), 0);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.equal(manager({ sessionsFile: path.join(dir, 'bad.json') }).m.restore(), 0);
});

test('recordings are written per match when a data dir is given', () => {
  const dir = tmp();
  const { m, started } = manager({ dataDir: dir });
  m.add(URL1);
  m.add(URL2);
  started[0].onUpdate(state(3, 4, 2));
  started[1].onUpdate(state(5, 1, 1));
  started[0].onEnd({ reason: 'finished', final: { home: 4, away: 2 } });
  m.remove(m.list()[1].id);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
});
