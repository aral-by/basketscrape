// startWatcher yaşam döngüsü testleri. Gerçek Chrome yerine sahte bir Puppeteer kullanılır:
// require önbelleğine enjekte edilir, böylece testler ağ ve tarayıcı olmadan milisaniyelerde koşar.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

// ── Sahte Puppeteer ─────────────────────────────────────────────────────────
const SEL = {
  home:   '.duelParticipant__home .participant__participantName',
  away:   '.duelParticipant__away .participant__participantName',
  period: '.smh__stage',
  minute: '.detailScore__status .eventTime',
  hScore: '.detailScore__wrapper > span:first-child',
  aScore: '.detailScore__wrapper > span:last-child',
};

const fake = {
  dom: {},          // selector → metin
  launches: 0,
  browsers: [],
  setDom({ period = null, minute = null, home = null, away = null } = {}) {
    this.dom = {
      [SEL.home]: 'Ev Takımı', [SEL.away]: 'Deplasman Takımı',
      [SEL.period]: period, [SEL.minute]: minute, [SEL.hScore]: home, [SEL.aScore]: away,
    };
  },
};

class FakePage {
  constructor(browser) { this.browser = browser; }
  async setUserAgent() {}
  async setViewport() {}
  async goto() { this._check(); }
  async reload() { this._check(); }
  async $eval(sel, fn) {
    this._check();
    const text = fake.dom[sel];
    if (text == null) throw new Error('no element: ' + sel);
    return fn({ textContent: String(text) });
  }
  async evaluate() { this._check(); return null; }   // XPath yedekleri / debug: bulunamadı
  async click() { this._check(); throw new Error('no stats tab'); }
  async waitForSelector() { throw new Error('timeout'); }
  _check() { if (this.browser.closed) throw new Error('Target closed'); }
}

class FakeBrowser extends EventEmitter {
  constructor() { super(); this.closed = false; }
  async newPage() { return new FakePage(this); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('disconnected');
  }
  crash() { this.closed = true; this.emit('disconnected'); }
}

require.cache[require.resolve('puppeteer')] = {
  id: 'puppeteer', filename: 'puppeteer', loaded: true,
  exports: {
    async launch() {
      fake.launches++;
      const b = new FakeBrowser();
      fake.browsers.push(b);
      return b;
    },
  },
};

const { startWatcher } = require('../src/scraper');

// ── Yardımcılar ─────────────────────────────────────────────────────────────
const FAST = { mainInterval: 5, startPollInterval: 5, statsInterval: 1e9, staleReloadMs: 1e9 };
const tick = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor zaman aşımı');
    await tick(2);
  }
}

function watch(opts = FAST) {
  const ev = { updates: [], ends: [], statuses: [], logs: [] };
  const w = startWatcher(
    'https://www.flashscore.com/match/x',
    s => ev.updates.push(s),
    r => ev.ends.push(r),
    m => ev.logs.push(m),
    s => ev.statuses.push(s.status),
    opts,
  );
  return { w, ev };
}

test.beforeEach(() => {
  fake.launches = 0;
  fake.browsers = [];
  fake.setDom();
});

// ── Testler ─────────────────────────────────────────────────────────────────
test('startWatcher { stop } nesnesini senkron olarak hemen döndürür', () => {
  const { w } = watch();
  assert.equal(typeof w.stop, 'function');
  assert.ok(!(w instanceof Promise));
  w.stop();
});

test('maç başlamadan stop() tarayıcıyı kapatır ve beklemeyi bitirir', async () => {
  const { w, ev } = watch();
  await waitFor(() => ev.statuses.includes('not_started'));

  w.stop();
  await tick(30);

  assert.equal(fake.browsers.length, 1);
  assert.equal(fake.browsers[0].closed, true);
  assert.equal(ev.ends.length, 0, 'stop() onEnd çağırmamalı');
  assert.equal(ev.updates.length, 0);
});

test('tarayıcı açılırken stop() çağrılırsa açılan tarayıcı da kapanır', async () => {
  const { w } = watch();
  w.stop();               // launch() henüz çözülmedi
  await tick(30);
  assert.ok(fake.browsers.every(b => b.closed));
});

test('maç başlayınca ana döngü dakika verisini yayınlar', async () => {
  const { w, ev } = watch();
  await waitFor(() => ev.statuses.includes('not_started'));

  fake.setDom({ period: '1. Çeyrek', minute: "1'", home: '0', away: '0' });
  await waitFor(() => ev.statuses.includes('running'));
  fake.setDom({ period: '1. Çeyrek', minute: "2'", home: '3', away: '2' });
  await waitFor(() => ev.updates.some(u => u.lastAbsoluteMinute === 2));

  const last = ev.updates.at(-1);
  assert.equal(last.homeName, 'Ev Takımı');
  assert.equal(last.homeMinutes[1], 3);
  assert.equal(last.awayMinutes[1], 2);
  w.stop();
});

test('devre arasında skor tablosu güncellenmez', async () => {
  fake.setDom({ period: 'Devre Arası', home: '40', away: '38' });
  const { w, ev } = watch();
  await waitFor(() => ev.statuses.includes('running'));
  await tick(40);
  assert.equal(ev.updates.length, 0);
  w.stop();
});

test('maç bitince onEnd bir kez çağrılır ve tarayıcı kapanır', async () => {
  fake.setDom({ period: '4. Çeyrek', minute: "10'", home: '80', away: '75' });
  const { ev } = watch();
  await waitFor(() => ev.updates.length > 0);

  fake.setDom({ period: 'Bitti', home: '82', away: '75' });
  await waitFor(() => ev.ends.length > 0);
  await tick(30);

  assert.equal(ev.ends.length, 1);
  assert.equal(ev.ends[0].reason, 'finished');
  assert.equal(ev.ends[0].state.homeName, 'Ev Takımı');
  assert.ok(fake.browsers.every(b => b.closed));
});

test('zaten bitmiş maç: already_finished ile sonlanır', async () => {
  fake.setDom({ period: 'Bitti', home: '90', away: '85' });
  const { ev } = watch();
  await waitFor(() => ev.ends.length > 0);
  assert.equal(ev.ends[0].reason, 'already_finished');
  assert.deepEqual(ev.statuses, ['finished']);
});

test('tarayıcı çökerse yeniden açılır ve skor tablosu korunur', async () => {
  fake.setDom({ period: '2. Çeyrek', minute: "1'", home: '20', away: '20' });
  const { w, ev } = watch();
  await waitFor(() => ev.updates.length > 0);

  fake.setDom({ period: '2. Çeyrek', minute: "2'", home: '22', away: '20' });
  await waitFor(() => ev.updates.some(u => u.lastAbsoluteMinute === 12));

  fake.browsers[0].crash();
  fake.setDom({ period: '2. Çeyrek', minute: "3'", home: '25', away: '21' });
  await waitFor(() => ev.updates.some(u => u.lastAbsoluteMinute === 13));

  assert.equal(fake.launches, 2);
  const last = ev.updates.at(-1);
  assert.equal(last.homeMinutes[11], 2);   // çökmeden önceki veri duruyor
  assert.equal(last.homeMinutes[12], 3);
  assert.equal(last.awayMinutes[12], 1);
  w.stop();
});

test('stop() sonrasında hiçbir callback tetiklenmez', async () => {
  fake.setDom({ period: '1. Çeyrek', minute: "1'", home: '0', away: '0' });
  const { w, ev } = watch();
  await waitFor(() => ev.updates.length > 0);
  w.stop();
  const counts = [ev.updates.length, ev.ends.length, ev.statuses.length];
  fake.setDom({ period: 'Bitti', home: '2', away: '0' });
  await tick(40);
  assert.deepEqual([ev.updates.length, ev.ends.length, ev.statuses.length], counts);
});
