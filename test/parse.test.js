const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQuarter, parseMinute, parseScore, isMatchFinished, isHalftime, isAllowedMatchUrl,
} = require('../src/parse');

test('parseQuarter: Türkçe ve İngilizce periyot metinleri', () => {
  const cases = {
    '1. Çeyrek': 1, '4. çeyrek': 4, '2. Çeyrek6\'': 2,
    '1. Uzatma': 5, '2. Uzatma': 6, 'Uzatma': 5,
    'Q1': 1, 'q3': 3, '2nd Quarter': 2, '4th Quarter': 4,
    'OT': 5, 'OT2': 6, '3': 3,
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.equal(parseQuarter(text), expected, text);
  }
  for (const text of [null, '', 'Devre Arası', 'Bitti', 'Başlamadı']) {
    assert.equal(parseQuarter(text), null, String(text));
  }
});

test('parseMinute: ayrı element önce, yoksa periyot metninin sonu', () => {
  assert.equal(parseMinute("6'", '2. Çeyrek'), 6);
  assert.equal(parseMinute(null, "2. Çeyrek6'"), 6);
  assert.equal(parseMinute(null, '3. Çeyrek 10’'), 10);
  assert.equal(parseMinute(null, '1. Çeyrek'), null);
  assert.equal(parseMinute(null, '2'), null);
  assert.equal(parseMinute('', null), null);
});

test('parseScore: rakam olmayan metin null döner (0 değil)', () => {
  assert.equal(parseScore('87'), 87);
  assert.equal(parseScore(' 0 '), 0);
  assert.equal(parseScore('-'), null);
  assert.equal(parseScore(null), null);
});

test('isMatchFinished / isHalftime', () => {
  for (const t of ['Bitti', 'MS', 'Final', 'Uzatmalardan Sonra Bitti', 'Finished']) {
    assert.equal(isMatchFinished(t), true, t);
  }
  for (const t of ['1. Çeyrek', 'Devre Arası', null]) {
    assert.equal(isMatchFinished(t), false, String(t));
  }
  for (const t of ['Devre Arası', 'HT', 'Halftime', 'Break']) {
    assert.equal(isHalftime(t), true, t);
  }
  assert.equal(isHalftime('3. Çeyrek'), false);
});

test('isAllowedMatchUrl: yalnızca Flashscore adresleri', () => {
  for (const u of [
    'https://www.flashscore.com/match/basketball/abc/#/match-summary',
    'https://www.flashscore.com.tr/mac/basketbol/abc/',
    'https://flashscore.co.uk/match/x',
    'https://www.flashscore.de/spiel/x',
  ]) assert.equal(isAllowedMatchUrl(u), true, u);

  for (const u of [
    'file:///etc/passwd',
    'http://localhost:3010',
    'http://169.254.169.254/latest/meta-data',
    'https://flashscore.com.evil.example/x',
    'https://notflashscore.com/x',
    'javascript:alert(1)',
    'flashscore.com',
    '',
  ]) assert.equal(isAllowedMatchUrl(u), false, u);
});
