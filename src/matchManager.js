// Several matches at once in one process. Each match is a session with its own watcher (a tab
// in the shared Chrome), recorder and live forecast. Events are tagged with the match id.
//
// Active (unfinished) matches are saved to a small JSON file and resumed after a restart,
// so closing the window or rebooting the PC does not lose the list.
const fs = require('fs');
const path = require('path');
const { MatchRecorder, matchIdFromUrl } = require('./recorder');
const { LiveForecast } = require('./liveForecast');
const { competitionOf } = require('./euroleagueLive');

const MAX_LOGS = 60;

class MatchManager {
  /**
   * @param {object} o
   * @param {Function} o.startWatcher   scraper.startWatcher (or demo / fake)
   * @param {Function} o.emit           (event, payload) → broadcast
   * @param {object|null} o.predictor   eb_plus Predictor
   * @param {string|null} o.dataDir     recordings dir, null = do not record
   * @param {string|null} o.sessionsFile  where to persist active matches, null = do not
   * @param {number} o.maxMatches
   */
  /**
   * @param {object} [o.official]      EuroleagueLive: player box score / team fouls for EuroLeague & EuroCup
   * @param {number} [o.officialEveryMs]
   */
  constructor({ startWatcher, emit, predictor = null, dataDir = null, sessionsFile = null, maxMatches = 8,
    now = () => Date.now(), official = null, officialEveryMs = 20000 }) {
    this.official = official;
    this.officialEveryMs = officialEveryMs;
    this.startWatcher = startWatcher;
    this.emit = emit || (() => {});
    this.predictor = predictor;
    this.dataDir = dataDir;
    this.sessionsFile = sessionsFile;
    this.maxMatches = maxMatches;
    this.now = now;
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.addedAt - b.addedAt).map((s) => this.snapshot(s));
  }

  snapshot(s) {
    return {
      id: s.id, url: s.url, addedAt: s.addedAt,
      status: s.status, update: s.update, prediction: s.prediction, end: s.end, logs: s.logs, box: s.box || null,
    };
  }

  /** Starts watching `url`. The same match twice returns the existing session. */
  add(url) {
    const id = matchIdFromUrl(url);
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.watcher || !existing.end) return { session: this.snapshot(existing), existed: true };
      this.remove(id);   // finished earlier: watch again from scratch
    }
    const active = [...this.sessions.values()].filter((s) => s.watcher).length;
    if (active >= this.maxMatches) {
      const err = new Error(`Aynı anda en fazla ${this.maxMatches} maç izlenebilir.`);
      err.code = 'LIMIT';
      throw err;
    }

    const s = {
      id, url, addedAt: this.now(),
      status: { status: 'starting', message: 'Başlatılıyor…' },
      update: null, prediction: null, end: null, logs: [],
      watcher: null,
      recorder: this.dataDir ? new MatchRecorder(url, { dir: this.dataDir }) : null,
      forecast: new LiveForecast(this.predictor),
    };
    this.sessions.set(id, s);
    this.emit('match:added', this.snapshot(s));
    this._log(s, 'Scraper başlatılıyor…');

    let watcher = null;
    const alive = () => watcher !== null && this.sessions.get(id) === s && s.watcher === watcher;
    watcher = this.startWatcher(
      url,
      (state) => {
        if (!alive()) return;
        if (s.recorder) s.recorder.update(state);
        s.update = state;
        this.emit('match:update', { id, state });
        s.prediction = s.forecast.update(state);
        this.emit('match:prediction', { id, prediction: s.prediction });
        this._official(s, state);
      },
      (result) => {
        if (!alive()) return;
        if (s.recorder) s.recorder.finish(result);
        s.end = result;
        s.watcher = null;
        const done = s.forecast.finish(result);
        if (done) {
          s.prediction = done;
          this.emit('match:prediction', { id, prediction: done });
        }
        this.emit('match:end', { id, result });
        this._stopOfficial(s, true);
        this._persist();
      },
      (msg) => { if (alive()) this._log(s, msg); },
      (statusInfo) => {
        if (!alive()) return;
        s.status = statusInfo;
        this.emit('match:status', { id, status: statusInfo });
      },
    );
    s.watcher = watcher;
    this._persist();
    return { session: this.snapshot(s), existed: false };
  }

  /** Stops watching and forgets the match. */
  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    if (s.watcher) s.watcher.stop();
    s.watcher = null;
    this._stopOfficial(s, false);
    if (s.recorder) s.recorder.stop();
    this.emit('match:removed', { id });
    this._persist();
    return true;
  }

  stopAll() {
    for (const s of this.sessions.values()) {
      if (s.watcher) s.watcher.stop();
      s.watcher = null;
      this._stopOfficial(s, false);
      if (s.recorder) s.recorder.stop();
    }
  }

  // ── Official EuroLeague / EuroCup data (players, team fouls, plays) ──────
  _official(s, state) {
    if (!this.official || s.officialOff) return;
    if (state.officialGame) {                       // demo replay knows its game
      s.game = { ...state.officialGame, demo: true };
      s.uptoMinute = state.lastAbsoluteMinute;
      this._fetchOfficial(s);                       // downloaded once, re-cut every minute
      return;
    }
    if (!s.game) {
      if (!competitionOf(state.league) || !state.homeName || !state.awayName) return;
      if (s.findingAt && this.now() - s.findingAt < 5 * 60e3) return;   // retry every 5 min
      s.findingAt = this.now();
      this.official.find(state).then((g) => {
        if (!this.sessions.has(s.id) || !g) {
          if (g === null) this._log(s, 'Resmi EuroLeague maçı henüz eşleşmedi; 5 dk sonra tekrar denenecek.');
          return;
        }
        s.game = g;
        this._log(s, `Resmi veri bağlandı: ${g.season} #${g.gameCode} (${g.home} – ${g.away}).`);
        this._pollOfficial(s);
      }).catch((e) => this._log(s, 'Resmi veri aranamadı: ' + e.message));
      return;
    }
    if (!s.officialTimer) this._pollOfficial(s);
  }

  _pollOfficial(s) {
    if (s.officialTimer || !s.game) return;
    const tick = () => this._fetchOfficial(s);
    tick();
    s.officialTimer = setInterval(tick, this.officialEveryMs);
    if (s.officialTimer.unref) s.officialTimer.unref();
  }

  _fetchOfficial(s) {
    if (!s.game || s.officialBusy) return Promise.resolve();
    s.officialBusy = true;
    const opts = s.game.demo ? { demo: true, uptoMinute: s.uptoMinute || 0 } : {};
    return this.official.fetch(s.game, opts).then((box) => {
      if (!box || !this.sessions.has(s.id)) return;
      s.box = box;
      this.emit('match:box', { id: s.id, box });
    }).catch((e) => {
      if (!s.officialErrorLogged) this._log(s, 'Resmi veri alınamadı: ' + e.message);
      s.officialErrorLogged = true;
    }).finally(() => { s.officialBusy = false; });
  }

  _stopOfficial(s, finalFetch) {
    if (s.officialTimer) clearInterval(s.officialTimer);
    s.officialTimer = null;
    if (finalFetch && s.game) this._fetchOfficial(s);   // final box score
    s.officialOff = true;
  }

  /** Re-adds the matches that were still being watched when the server last stopped. */
  restore() {
    if (!this.sessionsFile) return 0;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
    } catch {
      return 0;
    }
    let n = 0;
    for (const m of (saved && saved.matches) || []) {
      if (typeof m.url !== 'string') continue;
      try {
        this.add(m.url);
        n++;
      } catch { /* limit reached */ }
    }
    return n;
  }

  _log(s, msg) {
    const line = { at: this.now(), msg: String(msg) };
    s.logs.push(line);
    if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS);
    this.emit('match:log', { id: s.id, ...line });
  }

  _persist() {
    if (!this.sessionsFile) return;
    const matches = [...this.sessions.values()].filter((s) => s.watcher).map((s) => ({ url: s.url, addedAt: s.addedAt }));
    try {
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      const tmp = this.sessionsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ matches }, null, 1));
      fs.renameSync(tmp, this.sessionsFile);
    } catch { /* best effort */ }
  }
}

module.exports = { MatchManager };
