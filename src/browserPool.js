// One headless Chromium shared by every watched match: each match gets its own tab.
// Five matches used to mean five Chrome processes (one per app copy); now they share one.
//
//   const page = await pool.acquire(onLost)   // launches Chrome on first use
//   await pool.release(page)                  // closes the tab; Chrome closes with the last tab
//
// If Chrome crashes, every holder's onLost() is called once and the pool forgets those tabs;
// the next acquire() launches a fresh browser.
const puppeteer = require('puppeteer');

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  // every tab is "in the background" for headless Chrome; keep their timers and websockets live
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Images, fonts and video are not needed to read the scoreboard; skipping them makes each tab
// much lighter, which matters with several matches open.
const BLOCKED = new Set(['image', 'media', 'font']);

class BrowserPool {
  constructor({ launch } = {}) {
    this._launch = launch || (() => puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: LAUNCH_ARGS,
    }));
    this.browser = null;
    this._launching = null;
    this.pages = new Map();   // page → onLost
    this.launches = 0;
  }

  get size() { return this.pages.size; }

  async _getBrowser() {
    if (this.browser) return this.browser;
    if (!this._launching) {
      this._launching = (async () => {
        const b = await this._launch();
        this.launches++;
        b.on('disconnected', () => this._onDisconnect(b));
        this.browser = b;
        return b;
      })().finally(() => { this._launching = null; });
    }
    return this._launching;
  }

  _onDisconnect(b) {
    if (this.browser !== b) return;   // closed on purpose
    this.browser = null;
    const lost = [...this.pages.values()];
    this.pages.clear();
    for (const fn of lost) {
      try { if (fn) fn(); } catch { /* holder's problem */ }
    }
  }

  async acquire(onLost) {
    const b = await this._getBrowser();
    const page = await b.newPage();
    this.pages.set(page, onLost || null);
    try {
      await page.setUserAgent(USER_AGENT);
      await page.setViewport({ width: 1280, height: 800 });
      if (typeof page.setRequestInterception === 'function') {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (BLOCKED.has(req.resourceType())) req.abort().catch(() => {});
          else req.continue().catch(() => {});
        });
      }
    } catch { /* a bare tab still works */ }
    return page;
  }

  async release(page) {
    if (!page || !this.pages.delete(page)) return;   // unknown or already lost in a crash
    await page.close().catch(() => {});
    if (this.pages.size === 0 && !this._launching && this.browser) {
      const b = this.browser;
      this.browser = null;
      await b.close().catch(() => {});
    }
  }

  async closeAll() {
    const b = this.browser;
    this.browser = null;
    this.pages.clear();
    if (b) await b.close().catch(() => {});
  }
}

const shared = new BrowserPool();

module.exports = { BrowserPool, shared };
