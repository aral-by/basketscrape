// Per-match live forecast: turns scraper updates into model predictions, keeps the per-minute
// history and locks the prediction at the decision minute (lock rule exported with the model).
const fs = require('fs');
const path = require('path');
const { Predictor, completedMinutes } = require('./predictor');

const DEFAULT_MODEL = path.join(__dirname, '../models/eb_plus.json');

function loadPredictor(file = process.env.MODEL_PATH || DEFAULT_MODEL) {
  try {
    return new Predictor(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return null;
  }
}

function round(x, d = 1) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function slim(p) {
  return p && {
    t: p.t, S: p.S, mean: round(p.mean, 2), sd: round(p.sd, 3),
    lo80: round(p.lo80, 1), hi80: round(p.hi80, 1), pOT: round(p.pOT, 4),
    mix: {
      meanReg: round(p.mix.meanReg, 3), sdReg: round(p.mix.sdReg, 4), sdOt: round(p.mix.sdOt, 4),
      otMean: round(p.mix.otMean, 3), pOT: round(p.mix.pOT, 5),
    },
  };
}

class LiveForecast {
  constructor(predictor) {
    this.predictor = predictor;
    this.reset();
  }

  reset() {
    this.firstMinute = null;
    this.ctx = null;
    this.ctxKey = '';
    this.lock = null;
    this.last = null;
  }

  /** Model description for the panel (validation numbers come from the export). */
  info() {
    if (!this.predictor) return { available: false };
    const m = this.predictor.m;
    return {
      available: true, model: m.model, nMatches: m.n_matches, trainedUntil: m.trained_until,
      leagues: m.leagues_trained, lockRule: m.lock_rule, validation: m.validation,
    };
  }

  update(state) {
    if (!this.predictor) return { available: false, reason: 'Model dosyası bulunamadı (models/eb_plus.json).' };
    if (this.firstMinute === null && state.lastAbsoluteMinute) this.firstMinute = state.lastAbsoluteMinute;

    const key = [state.league, state.homeName, state.awayName].join('|');
    if (!this.ctx || key !== this.ctxKey) {
      this.ctx = this.predictor.context(state.league, state.homeName, state.awayName);
      this.ctxKey = key;
    }
    const ctx = this.ctx;
    if (!ctx.league) {
      // Model yalnızca doğrulandığı liglerde tahmin yapar (EuroLeague, EuroCup).
      this.last = {
        available: false, unsupported: true, league: state.league || null,
        supported: this.predictor.m.leagues_trained,
        reason: 'Tahmin motoru yalnızca EuroLeague ve EuroCup maçlarında çalışır.',
      };
      return this.last;
    }
    const inputs = completedMinutes(state, this.firstMinute);
    const history = inputs
      .map((x) => this.predictor.predict({ ...x, league: state.league, lgRecent: ctx.lgRecent, teamDev: ctx.teamDev }))
      .filter(Boolean);

    if (!this.lock) {
      const lt = this.predictor.lockMinute(history);
      if (lt !== null) {
        const p = history.find((h) => h.t === lt);
        if (p) this.lock = slim(p);
      }
    }

    const now = history.length ? history[history.length - 1] : null;
    this.last = {
      available: true,
      context: {
        league: ctx.league, trained: !!ctx.league,
        home: ctx.home && ctx.home.name, away: ctx.away && ctx.away.name,
        teamDev: ctx.teamDev == null ? null : round(ctx.teamDev, 2),
      },
      firstMinute: this.firstMinute,
      liveMinute: state.lastAbsoluteMinute,
      overtime: state.lastAbsoluteMinute > 40,
      now: slim(now),
      history: history.map((h) => ({ t: h.t, S: h.S, mean: round(h.mean, 2), lo80: round(h.lo80, 1), hi80: round(h.hi80, 1) })),
      lock: this.lock,
      lockRule: this.predictor.m.lock_rule,
    };
    return this.last;
  }

  /** On match end: attach the final total and the lock's error. */
  finish(result) {
    if (!this.last || !result || !result.final) return this.last;
    const total = Number(result.final.home) + Number(result.final.away);
    if (!isFinite(total)) return this.last;
    this.last = { ...this.last, final: total, lockError: this.lock ? round(total - this.lock.mean, 1) : null };
    return this.last;
  }
}

module.exports = { LiveForecast, loadPredictor };
