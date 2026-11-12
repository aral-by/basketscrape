const test = require('node:test');
const assert = require('node:assert/strict');
const ScoreBoard = require('../src/gameState');
const { toAbsoluteMinute } = require('../src/gameState');

function feed(sb, rows) {
  for (const [p, m, h, a] of rows) sb.update(p, m, h, a);
  return sb.getState();
}

test('toAbsoluteMinute: çeyrekler 10, uzatmalar 5 dakika', () => {
  assert.equal(toAbsoluteMinute(1, 1), 1);
  assert.equal(toAbsoluteMinute(4, 10), 40);
  assert.equal(toAbsoluteMinute(5, 1), 41);  // 1. uzatma
  assert.equal(toAbsoluteMinute(5, 5), 45);
  assert.equal(toAbsoluteMinute(6, 1), 46);  // 2. uzatma
  assert.equal(toAbsoluteMinute(7, 5), 55);  // 3. uzatma
});

test('ilk güncelleme baseline olur, hücre 0 kalır (maç ortası başlangıç)', () => {
  const st = feed(new ScoreBoard(), [[4, 5, 66, 75]]);
  assert.equal(st.lastAbsoluteMinute, 35);
  assert.equal(st.homeMinutes[34], 0);
  assert.equal(st.awayMinutes[34], 0);
});

test('dakika başına sayı, kümülatif skordan doğru türetilir', () => {
  const st = feed(new ScoreBoard(), [
    [1, 1, 0, 0],
    [1, 2, 2, 0],
    [1, 3, 5, 2],
    [1, 4, 5, 2],
  ]);
  assert.deepEqual(st.homeMinutes.slice(0, 4), [0, 2, 3, 0]);
  assert.deepEqual(st.awayMinutes.slice(0, 4), [0, 0, 2, 0]);
});

test('aynı dakikadaki birden fazla okuma toplanmaz, üzerine yazılır', () => {
  const st = feed(new ScoreBoard(), [
    [1, 1, 0, 0],
    [1, 2, 2, 0],
    [1, 2, 4, 0],
    [1, 2, 7, 1],
  ]);
  assert.equal(st.homeMinutes[1], 7);
  assert.equal(st.awayMinutes[1], 1);
});

test('atlanan dakikalar 0, sayılar geldikleri dakikaya yazılır', () => {
  const st = feed(new ScoreBoard(), [
    [1, 1, 0, 0],
    [1, 5, 6, 3],
  ]);
  assert.deepEqual(st.homeMinutes.slice(0, 5), [0, 0, 0, 0, 6]);
  assert.equal(st.lastAbsoluteMinute, 5);
});

test('periyot geçişi: 1. çeyrek 10. dk → 2. çeyrek 1. dk = mutlak 11', () => {
  const st = feed(new ScoreBoard(), [
    [1, 10, 20, 18],
    [2, 1, 22, 18],
  ]);
  assert.equal(st.lastAbsoluteMinute, 11);
  assert.equal(st.homeMinutes[10], 2);
});

test('uzatmalar: 2. uzatma 46-50. hücrelere yazılır (55 değil)', () => {
  const st = feed(new ScoreBoard(), [
    [4, 10, 80, 80],
    [5, 1, 82, 80],
    [5, 5, 84, 84],
    [6, 1, 86, 84],
  ]);
  assert.equal(st.totalCells, 50);
  assert.equal(st.lastAbsoluteMinute, 46);
  assert.equal(st.homeMinutes[40], 2);
  assert.equal(st.homeMinutes[45], 2);
  assert.equal(st.awayMinutes[44], 4);
});

test('skor düzeltmesi (3→2) geçmiş hücreden düşülür, diğer takım etkilenmez', () => {
  const st = feed(new ScoreBoard(), [
    [1, 1, 0, 0],
    [1, 2, 3, 0],  // ev 3'lük (sonradan 2'liğe düzeltilecek)
    [1, 3, 2, 2],  // düzeltme + deplasman 2 sayı
    [1, 4, 5, 4],
  ]);
  assert.deepEqual(st.homeMinutes.slice(0, 4), [0, 2, 0, 3]);
  assert.deepEqual(st.awayMinutes.slice(0, 4), [0, 0, 2, 2]);
  // Toplam her zaman son skora eşit
  assert.equal(st.homeMinutes.reduce((a, b) => a + b, 0), 5);
  assert.equal(st.awayMinutes.reduce((a, b) => a + b, 0), 4);
});

test('aynı dakika içindeki skor düzeltmesi o dakikanın hücresini düşürür', () => {
  const sb = new ScoreBoard();
  const st = feed(sb, [
    [1, 1, 0, 0],
    [1, 2, 3, 0],
    [1, 2, 2, 0],
    [1, 3, 4, 0],
  ]);
  assert.deepEqual(st.homeMinutes.slice(0, 3), [0, 2, 2]);
});

test('baseline sonrası düzeltme baseline\'dan düşülür, hücreler negatif olmaz', () => {
  const st = feed(new ScoreBoard(), [
    [2, 1, 30, 30],  // maç ortası başlangıç
    [2, 2, 29, 30],  // daha önceki bir sayının düzeltmesi
    [2, 3, 31, 30],
  ]);
  assert.ok(st.homeMinutes.every(v => v >= 0));
  assert.equal(st.homeMinutes[12], 2);
});

test('büyük skor düşüşü scrape hatası sayılır ve tüm okuma reddedilir', () => {
  const sb = new ScoreBoard();
  feed(sb, [[1, 1, 0, 0], [1, 5, 20, 18]]);
  assert.equal(sb.update(1, 6, 0, 20), false);
  const st = sb.getState();
  assert.equal(st.lastAbsoluteMinute, 5);
  assert.equal(st.awayMinutes[5], 0);
});

test('geriye giden dakika ve geçersiz girdiler reddedilir', () => {
  const sb = new ScoreBoard();
  feed(sb, [[1, 1, 0, 0], [2, 3, 30, 30]]);
  assert.equal(sb.update(2, 2, 32, 30), false);
  assert.equal(sb.update(1, 11, 32, 30), false);
  assert.equal(sb.update(5, 6, 32, 30), false);
  assert.equal(sb.update(0, 1, 32, 30), false);
  assert.equal(sb.getState().lastAbsoluteMinute, 13);
});

test('getState kopya döndürür', () => {
  const sb = new ScoreBoard();
  const st = sb.getState();
  st.homeMinutes[0] = 99;
  assert.equal(sb.getState().homeMinutes[0], 0);
});
