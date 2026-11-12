const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MatchRecorder, matchIdFromUrl } = require('../src/recorder');

const URL_A = 'https://www.flashscore.com/match/basketball/a-x0WjVzjP/b-nLuro05B/?mid=8bAdpkMc';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bs-rec-'));
}
function readOnly(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1, 'tek kayıt dosyası beklenir: ' + files.join(','));
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}
function upd(m, h, a, extra = {}) {
  return { lastAbsoluteMinute: m, homeScore: h, awayScore: a, homeName: 'A', awayName: 'B', ...extra };
}
const fixedNow = () => new Date('2026-11-12T19:05:00Z');

test('matchIdFromUrl: mid parametresi, eski yol biçimi ve hash yedeği', () => {
  assert.equal(matchIdFromUrl(URL_A), '8bAdpkMc');
  assert.equal(matchIdFromUrl('https://www.flashscore.com.tr/mac/pMWvS76T/#/mac-ozeti'), 'pMWvS76T');
  assert.match(matchIdFromUrl('https://www.flashscore.com/x/y'), /^u[0-9a-f]{10}$/);
});

test('her dakikanın son okuması kümülatif olarak kaydedilir, maç sonu skoru yazılır', () => {
  const dir = tmpDir();
  const r = new MatchRecorder(URL_A, { dir, now: fixedNow });
  r.update(upd(1, 0, 0, { league: 'Euroleague' }));
  r.update(upd(1, 2, 0));
  r.update(upd(2, 4, 3));
  r.update(upd(4, 9, 5));             // 3. dakika atlandı
  r.finish({ reason: 'finished', final: { home: 9, away: 7 }, state: {} });

  const rec = readOnly(dir);
  assert.equal(rec.id, '8bAdpkMc');
  assert.equal(rec.status, 'finished');
  assert.equal(rec.league, 'Euroleague');
  assert.deepEqual(rec.cumulative.home, [2, 4, null, 9]);
  assert.deepEqual(rec.cumulative.away, [0, 3, null, 5]);
  assert.equal(rec.observedMinutes, 3);
  assert.equal(rec.firstObservedMinute, 1);
  assert.deepEqual(rec.final, { home: 9, away: 7 });
  assert.ok(fs.readdirSync(dir).every(f => !f.endsWith('.tmp')));
});

test('maç ortası başlangıç: önceki dakikalar null, firstObservedMinute doğru', () => {
  const dir = tmpDir();
  const r = new MatchRecorder(URL_A, { dir });
  r.update(upd(23, 50, 48));
  r.update(upd(24, 52, 48));
  r.stop();
  const rec = readOnly(dir);
  assert.equal(rec.status, 'stopped');
  assert.equal(rec.firstObservedMinute, 23);
  assert.equal(rec.cumulative.home.slice(0, 22).every(v => v === null), true);
});

test('uzatmalı maç: regulation 40. dk skoru, overtimePeriods sayısı', () => {
  const dir = tmpDir();
  const r = new MatchRecorder(URL_A, { dir });
  r.update(upd(40, 80, 80));
  r.update(upd(46, 90, 88));
  r.finish({ reason: 'finished', final: { home: 95, away: 90 }, state: {} });
  const rec = readOnly(dir);
  assert.deepEqual(rec.regulation, { home: 80, away: 80 });
  assert.equal(rec.overtimePeriods, 2);
  assert.equal(rec.totalCells, 46);
});

test('aynı maç yeniden başlatılırsa önceki gözlemler korunur (dosya birleştirme)', () => {
  const dir = tmpDir();
  const r1 = new MatchRecorder(URL_A, { dir });
  r1.update(upd(5, 10, 8));
  r1.update(upd(6, 12, 8));
  r1.stop();

  const r2 = new MatchRecorder(URL_A, { dir });
  r2.update(upd(9, 18, 15));
  r2.stop();

  const rec = readOnly(dir);
  assert.equal(rec.cumulative.home[4], 10);
  assert.equal(rec.cumulative.home[5], 12);
  assert.equal(rec.cumulative.home[8], 18);
  assert.equal(rec.observedMinutes, 3);
});

test('hiç dakika gözlenmeyen maç (zaten bitmiş) için dosya yazılmaz', () => {
  const dir = tmpDir();
  const r = new MatchRecorder(URL_A, { dir });
  r.finish({ reason: 'already_finished', final: { home: 90, away: 85 }, state: {} });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('hata ile biten maç error durumunda kaydedilir, final yazılmaz', () => {
  const dir = tmpDir();
  const r = new MatchRecorder(URL_A, { dir });
  r.update(upd(12, 20, 22));
  r.finish({ reason: 'error', error: 'x', state: {} });
  const rec = readOnly(dir);
  assert.equal(rec.status, 'error');
  assert.equal(rec.final, null);
});
