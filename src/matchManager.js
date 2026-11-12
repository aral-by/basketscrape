// Several matches at once in one process. Each match is a session with its own watcher (a tab
// in the shared Chrome), recorder and live forecast. Events are tagged with the match id.
//
// Active (unfinished) matches are saved to a small JSON file and resumed after a restart,
// so closing the window or rebooting the PC does not lose the list.
const fs = require('fs');
const path = require('path');
const { MatchRecorder, matchIdFromUrl } = require('./recorder');
const { LiveForecast } = require('./liveForecast');

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
  constructor({ startWatcher, emit, predictor = null, dataDir = null, sessionsFile = null, maxMatches = 8, now = () => Date.now() }) {
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
      status: s.status, update: s.update, prediction: s.prediction, end: s.end, logs: s.logs,
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
    if (s.recorder) s.recorder.stop();
    this.emit('match:removed', { id });
    this._persist();
    return true;
  }

  stopAll() {
    for (const s of this.sessions.values()) {
      if (s.watcher) s.watcher.stop();
      s.watcher = null;
      if (s.recorder) s.recorder.stop();
    }
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
