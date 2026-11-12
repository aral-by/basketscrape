/*
 * Live full-time total prediction — JavaScript port of ml/basketml/models.py:EmpiricalBayesPlus.
 *
 * The parameters come from `python -m basketml export` (models/eb_plus.json). The port is
 * checked against Python on 200 cases by test/predictor.test.js (fixture written by the same
 * export command), so the numbers in the panel are exactly the validated model's numbers.
 *
 * Runs in Node (require) and in the browser (window.BasketPredictor): the panel recomputes
 * P(over line) locally while the user types a line.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BasketPredictor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const REGULATION = 40;

  // ── math helpers ──────────────────────────────────────────────────────────
  // erfc with |rel. error| < 1.2e-7 (Numerical Recipes erfcc)
  function erfc(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
      t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  /** P(X > x) for X ~ N(mean, sd) */
  function normSf(x, mean, sd) { return 0.5 * erfc((x - mean) / (sd * Math.SQRT2)); }

  /** numpy.interp over a {minute: value} table (clamped at both ends) */
  function interpTable(table, t) {
    const keys = Object.keys(table || {}).map(Number).sort((a, b) => a - b);
    if (!keys.length) return 1;
    if (t <= keys[0]) return table[keys[0]];
    if (t >= keys[keys.length - 1]) return table[keys[keys.length - 1]];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i]) {
        const a = keys[i - 1], b = keys[i];
        const w = (t - a) / (b - a);
        return table[a] * (1 - w) + table[b] * w;
      }
    }
    return table[keys[keys.length - 1]];
  }

  // ── names ─────────────────────────────────────────────────────────────────
  const FOLD = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'İ': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'é': 'e', 'è': 'e',
    'á': 'a', 'à': 'a', 'ó': 'o', 'ò': 'o', 'í': 'i', 'ú': 'u', 'ñ': 'n', 'ž': 'z', 'š': 's', 'č': 'c', 'ć': 'c' };

  /** Same normalisation as features.league_key in Python. */
  function leagueKey(name) {
    if (!name) return '';
    let head = String(name).split(' - ')[0];
    head = head.replace(/\d{4}(-\d{2,4})?/g, '');
    return head.toLowerCase().replace(/[^a-z]/g, '');
  }

  function tokens(name) {
    return String(name || '').toLowerCase().replace(/./g, (c) => FOLD[c] || c)
      .split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  }

  class Predictor {
    constructor(model) {
      if (!model || model.model !== 'eb_plus') throw new Error('eb_plus model parameters expected');
      this.m = model;
      this.leagues = (model.context && model.context.leagues) || {};
      this.teams = (model.context && model.context.teams) || {};
    }

    /** Exact key, else a known key the given key ends with ("basketballeuropeeuroleague"). */
    resolveLeague(name) {
      const key = leagueKey(name);
      const known = Object.keys(this.leagues);
      if (known.includes(key)) return key;
      return known.find((k) => k && key.endsWith(k)) || null;
    }

    /** Live (Flashscore) team name → model team, by word overlap; most recent wins ties. */
    resolveTeam(leagueKeyResolved, name) {
      const table = this.teams[leagueKeyResolved];
      const want = tokens(name);
      if (!table || !want.length) return null;
      let best = null;
      for (const [team, info] of Object.entries(table)) {
        const have = tokens(team);
        const hit = want.filter((w) => have.includes(w)).length;
        if (!hit) continue;
        const score = hit / want.length;
        if (!best || score > best.score || (score === best.score && info.last > best.info.last)) {
          best = { team, info, score };
        }
      }
      return best && best.score >= 0.5 ? { name: best.team, dev: best.info.dev, games: best.info.n } : null;
    }

    /** Pre-game context for a live match (what Python computes from earlier matches). */
    context(league, homeName, awayName) {
      const lk = this.resolveLeague(league);
      if (!lk) return { league: null, lgRecent: null, teamDev: null, home: null, away: null };
      const home = this.resolveTeam(lk, homeName);
      const away = this.resolveTeam(lk, awayName);
      return {
        league: lk,
        lgRecent: this.leagues[lk].mean,
        teamDev: (home ? home.dev : 0) + (away ? away.dev : 0),
        home, away,
      };
    }

    _priorPerMin({ league, lgRecent, teamDev, line }) {
      const m = this.m;
      if (line != null && isFinite(line)) return (line / REGULATION) * m.line_scale;
      if (lgRecent != null && m.prior_beta) {
        const [b0, b1, b2] = m.prior_beta;
        return (b0 + b1 * lgRecent + b2 * (teamDev || 0)) / REGULATION;
      }
      const lm = m.league_mu_per_min || {};
      const key = leagueKey(league);
      if (key in lm) return lm[key];
      const suffix = Object.keys(lm).find((k) => k && key.endsWith(k));
      return suffix ? lm[suffix] : m.mu_per_min;
    }

    _ot(t, lam, r, margin) {
      const m = this.m;
      const rho = m.rho[Math.min(Math.max(t, 0), REGULATION)];
      const sdMargin = Math.sqrt(m.phi * rho * lam * r + 1);
      const z = margin / sdMargin;
      if (!m.ot_logit) return 0;
      const [c1, c2] = m.ot_logit.coef_z_z2;
      return 1 / (1 + Math.exp(-(m.ot_logit.intercept + c1 * z + c2 * z * z)));
    }

    /**
     * Prediction after `t` completed minutes with `S` total points and score margin `margin`.
     * Optional: league, lgRecent / teamDev (else league default), line (pregame line prior).
     * Returns the mean, an sd whose ±1.2816 band is a calibrated 80 % interval, and the
     * mixture components needed by probOver().
     */
    predict({ t, S, margin = 0, league = '', lgRecent = null, teamDev = null, line = null }) {
      if (!(t >= 1 && t < REGULATION)) return null;
      const m = this.m;
      const r = REGULATION - t;
      const mu = this._priorPerMin({ league, lgRecent, teamDev, line });
      const lam = (S + m.k * mu) / (t + m.k);
      const rho = m.rho[t];
      const meanReg = S + rho * lam * r;
      const varReg = m.phi * (rho * lam * r + (rho * r) ** 2 * lam / (t + m.k));
      const sdReg = Math.sqrt(varReg);
      const p = this._ot(t, lam, r, Math.abs(margin));
      const E = m.ot_points_mean, V = m.ot_points_var;
      const mean = meanReg + p * E;
      const sd = Math.sqrt(varReg + p * V + p * (1 - p) * E * E) * interpTable(m.sd_scale, t);
      const c = interpTable(m.reg_scale, t);
      const z80 = 1.2815515655446004;
      return {
        t, S, mean, sd, lo80: mean - z80 * sd, hi80: mean + z80 * sd, pOT: p,
        mix: { meanReg, sdReg: c * sdReg, sdOt: c * Math.sqrt(varReg + V), otMean: E, pOT: p },
      };
    }

    /** Lock rule: first minute in [from, to] whose sd ≤ σ*, else minute `to`. */
    lockMinute(history) {
      const rule = this.m.lock_rule || { from: 21, to: 30, sd_target: 9.5 };
      for (const h of history) {
        if (h.t >= rule.from && h.t <= rule.to && h.sd <= rule.sd_target) return h.t;
      }
      const last = history.length ? history[history.length - 1].t : 0;
      return last >= rule.to ? rule.to : null;
    }
  }

  /** P(final total > line) from the overtime mixture returned by predict(). */
  function probOver(mix, line) {
    if (!mix || line == null || !isFinite(line)) return null;
    return (1 - mix.pOT) * normSf(line, mix.meanReg, mix.sdReg) +
      mix.pOT * normSf(line, mix.meanReg + mix.otMean, mix.sdOt);
  }

  /**
   * Live scoreboard state (scraper onUpdate payload) → model inputs per completed minute.
   * The minute in progress is not finished, so the newest input is minute lastAbsoluteMinute−1,
   * whose end-of-minute score is the current score minus the current minute's points —
   * exactly the end-of-minute cumulative the model was trained on.
   * `firstMinute` is the first absolute minute this session observed (mid-match joins):
   * earlier minutes are unknown and are not reconstructed.
   */
  function completedMinutes(state, firstMinute = 1) {
    const { homeMinutes = [], awayMinutes = [], lastAbsoluteMinute: cur } = state || {};
    const hs = Number(state && state.homeScore), as = Number(state && state.awayScore);
    if (!cur || !isFinite(hs) || !isFinite(as)) return [];
    const out = [];
    let h = hs, a = as;
    for (let m = cur; m >= 1; m--) {        // walk back from the live score
      h -= homeMinutes[m - 1] || 0;
      a -= awayMinutes[m - 1] || 0;
      const t = m - 1;                       // score at the end of minute t
      if (t < Math.max(1, firstMinute)) break;
      if (t < REGULATION) out.push({ t, S: h + a, margin: h - a, home: h, away: a });
    }
    return out.reverse();
  }

  return { Predictor, probOver, completedMinutes, leagueKey, normSf, interpTable };
});
