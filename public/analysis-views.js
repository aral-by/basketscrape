/* Detailed analysis views for the selected match (new design).
 * Pure calculations live in BasketAnalysis.calc (also used by the tests through Node);
 * render(view, state) draws one view. Formulas: docs/analysis-metrics.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BasketAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // EuroLeague + EuroCup, 2873 games (ml/datasets/euroleague)
  const REF = {
    quarterMean: [41.5, 41.4, 40.1, 41.4],
    kriter1: { cond: 0.561, other: 0.587, base: 0.575, floorHit: 0.550 },
    decline: { cond: 0.408, other: 0.441, base: 0.425 },
    games: 2873,
  };

  // ── hesaplar ────────────────────────────────────────────────────────────
  function periods(totalCells) {
    const out = [];
    const n = Math.max(40, totalCells || 40);
    for (let start = 0; start < n;) {
      const len = start < 40 ? 10 : 5;
      out.push({ label: start < 40 ? `${start / 10 + 1}. Çeyrek` : `${(start - 40) / 5 + 1}. Uzatma`,
        short: start < 40 ? `Ç${start / 10 + 1}` : `U${(start - 40) / 5 + 1}`, from: start + 1, to: start + len, len });
      start += len;
    }
    return out;
  }

  function roundEg10(v) {
    const base = Math.floor(v);
    return (v - base) >= 0.7 - 1e-9 ? base + 1 : base;   // 10.7 must round up despite binary floats
  }

  /** Per-minute arrays, cumulative scores (anchored to the live score) and derived series. */
  function series(s) {
    const L = s.lastAbsoluteMinute || 0;
    const n = Math.max(L, 0);
    const h = [], a = [];
    for (let m = 1; m <= n; m++) { h.push(s.homeMinutes[m - 1] || 0); a.push(s.awayMinutes[m - 1] || 0); }
    // walk back from the live score: also right when the session joined mid-game
    const cumH = new Array(n), cumA = new Array(n);
    let ch = Number(s.homeScore) || 0, ca = Number(s.awayScore) || 0;
    for (let m = n; m >= 1; m--) { cumH[m - 1] = ch; cumA[m - 1] = ca; ch -= h[m - 1]; ca -= a[m - 1]; }
    const margin = cumH.map((v, i) => v - cumA[i]);
    const tot = h.map((v, i) => v + a[i]);
    const x40 = tot.map((v) => v * 40);
    const eg10 = [];
    for (const p of periods(s.totalCells)) {
      let cum = 0;
      for (let m = p.from; m <= Math.min(p.to, n); m++) {
        cum += tot[m - 1];
        eg10[m - 1] = roundEg10(cum * (40 / (m - p.from + 1)));
      }
    }
    const rolling = tot.map((_, i) => {
      const from = Math.max(0, i - 4);
      const w = tot.slice(from, i + 1);
      return w.reduce((x, y) => x + y, 0) / w.length * 40;
    });
    const momentum = h.map((_, i) => {
      let d = 0;
      for (let k = Math.max(0, i - 2); k <= i; k++) d += h[k] - a[k];
      return d;
    });
    return { L: n, h, a, tot, cumH, cumA, margin, x40, eg10, rolling, momentum, startH: ch, startA: ca };
  }

  /** Lead changes, ties, largest leads, runs and droughts (minute resolution). */
  function flowStats(sr, completed) {
    const n = completed;
    let leadChanges = 0, ties = 0, last = 0;
    let maxH = { v: 0, m: null }, maxA = { v: 0, m: null };
    for (let i = 0; i < n; i++) {
      const d = sr.margin[i];
      if (d > maxH.v) maxH = { v: d, m: i + 1 };
      if (-d > maxA.v) maxA = { v: -d, m: i + 1 };
      if (d === 0 && (sr.cumH[i] + sr.cumA[i]) > 0) ties++;
      const sign = Math.sign(d);
      if (sign !== 0) {
        if (last !== 0 && sign !== last) leadChanges++;
        last = sign;
      }
    }
    // runs: consecutive minutes in which only one team scored
    const runs = { home: { pts: 0 }, away: { pts: 0 } };
    let cur = null;
    const close = () => { if (cur && cur.pts > runs[cur.side].pts) runs[cur.side] = { ...cur }; };
    for (let i = 0; i < n; i++) {
      const hh = sr.h[i], aa = sr.a[i];
      const side = hh > 0 && aa === 0 ? 'home' : aa > 0 && hh === 0 ? 'away' : (hh === 0 && aa === 0 ? 'none' : 'both');
      if (side === 'none') { if (cur) cur.to = i + 1; continue; }
      if (side === 'both') { close(); cur = null; continue; }
      if (cur && cur.side === side) { cur.pts += side === 'home' ? hh : aa; cur.to = i + 1; }
      else { close(); cur = { side, pts: side === 'home' ? hh : aa, from: i + 1, to: i + 1 }; }
    }
    close();
    const drought = (arr) => {
      let best = { len: 0 }, run = 0, from = 0;
      for (let i = 0; i < n; i++) {
        if (arr[i] === 0) { if (run === 0) from = i + 1; run++; if (run > best.len) best = { len: run, from, to: i + 1 }; }
        else run = 0;
      }
      return best;
    };
    const bestMin = (arr) => arr.slice(0, n).reduce((b, v, i) => (v > b.v ? { v, m: i + 1 } : b), { v: 0, m: null });
    return {
      leadChanges, ties, maxH, maxA, runs,
      droughtH: drought(sr.h), droughtA: drought(sr.a),
      bestH: bestMin(sr.h), bestA: bestMin(sr.a), bestT: bestMin(sr.tot),
    };
  }

  function quarterTable(s, sr) {
    return periods(s.totalCells).filter((p) => p.from <= sr.L).map((p, i) => {
      let hh = 0, aa = 0;
      for (let m = p.from; m <= Math.min(p.to, sr.L); m++) { hh += sr.h[m - 1]; aa += sr.a[m - 1]; }
      const played = Math.min(p.to, sr.L) - p.from + 1;
      return { ...p, h: hh, a: aa, t: hh + aa, played, done: sr.L > p.to, pace: (hh + aa) / played, ref: REF.quarterMean[i] };
    });
  }

  // ── Flashscore istatistikleri ────────────────────────────────────────────
  function parseStat(v) {
    if (v == null) return { made: 0, att: 0, num: NaN, pct: false };
    const t = String(v);
    const frac = t.match(/(\d+)\s*\/\s*(\d+)/);
    if (frac) return { made: +frac[1], att: +frac[2], num: +frac[1], pct: false };
    const num = parseFloat(t.replace(',', '.').replace('%', ''));
    return { made: isNaN(num) ? 0 : num, att: 0, num, pct: t.includes('%') };
  }

  function flatStats(sections) {
    const map = {};
    (sections || []).forEach(({ rows }) => (rows || []).forEach(({ name, home, away }) => {
      map[String(name).toLowerCase().trim()] = { home: parseStat(home), away: parseStat(away) };
    }));
    return map;
  }

  /** First keyword wins (most specific first): "toplam rib" must not match "hücum ribaundu". */
  function findStat(flat, ...kws) {
    const keys = Object.keys(flat);
    for (const kw of kws) {
      const key = keys.find((k) => k.includes(kw));
      if (key) return flat[key];
    }
    return null;
  }

  const safe = (x) => (isFinite(x) ? x : 0);

  /** Four Factors, ratings, TS%, possessions, shooting splits — same formulas as the old page. */
  function teamMetrics(sections, homeScore, awayScore) {
    const flat = flatStats(sections);
    const g = (...k) => findStat(flat, ...k);
    const z = { home: { made: 0, att: 0 }, away: { made: 0, att: 0 } };
    const totalFg = g('alan gol', 'sahadan', 'field goal') || z;
    const fg2 = g('iki say', '2 say', '2-say', '2-point', 'two point') || z;
    const fg3 = g('üç say', '3 say', 'üçlük', '3-say', '3-point', 'three') || z;
    const ft = g('serbest atış', 'free throw', 'serbest') || z;
    const orb = g('hücum rib', 'ofansif r', 'off reb', 'offensive reb') || z;
    const drb = g('savunma rib', 'defansif r', 'def reb', 'defensive reb') || z;
    const reb = g('toplam rib', 'total reb') || null;
    const tov = g('top kayb', 'turnover', 'kayıp') || z;
    const ast = g('asist', 'assist') || z;
    const stl = g('top çal', 'steal') || z;
    const blk = g('blok', 'block') || z;
    const pf = g('faul', 'foul') || null;

    function side(k, pts) {
      const tot = totalFg[k], two = fg2[k], thr = fg3[k];
      let fgm, fga, fg2m, fg2a;
      if (tot.att > 0 && tot.att >= thr.att) { fgm = tot.made; fga = tot.att; fg2m = Math.max(0, fgm - thr.made); fg2a = Math.max(0, fga - thr.att); }
      else { fg2m = two.made; fg2a = two.att; fgm = two.made + thr.made; fga = two.att + thr.att; }
      return {
        pts: pts || 0, fgm, fga, fg2m, fg2a, fg3m: thr.made, fg3a: thr.att, ftm: ft[k].made, fta: ft[k].att,
        orb: orb[k].made, drb: drb[k].made, reb: reb ? reb[k].made : orb[k].made + drb[k].made,
        tov: tov[k].made, ast: ast[k].made, stl: stl[k].made, blk: blk[k].made, pf: pf ? pf[k].made : null,
      };
    }
    const H = side('home', homeScore), A = side('away', awayScore);
    const calc = (t, o) => {
      const fga = t.fga || 1;
      const poss = Math.max(1, t.fga - t.orb + t.tov + 0.44 * t.fta);
      return {
        efg: safe((t.fgm + 0.5 * t.fg3m) / fga),
        tovPct: safe(t.tov / ((t.fga + 0.44 * t.fta + t.tov) || 1)),
        orbPct: safe(t.orb / ((t.orb + o.drb) || 1)),
        ftr: safe(t.fta / fga),
        ts: safe(t.pts / (2 * ((t.fga + 0.44 * t.fta) || 1))),
        fgPct: t.fga ? t.fgm / t.fga : null, fg2Pct: t.fg2a ? t.fg2m / t.fg2a : null,
        fg3Pct: t.fg3a ? t.fg3m / t.fg3a : null, ftPct: t.fta ? t.ftm / t.fta : null,
        threeRate: t.fga ? t.fg3a / t.fga : null, astTov: t.tov ? t.ast / t.tov : null,
        astRate: t.fgm ? t.ast / t.fgm : null, poss,
        pts2: t.fg2m * 2, pts3: t.fg3m * 3, ptsFt: t.ftm,
      };
    };
    const h = calc(H, A), a = calc(A, H);
    const avgPoss = (h.poss + a.poss) / 2;
    h.offRtg = safe(100 * H.pts / avgPoss); a.offRtg = safe(100 * A.pts / avgPoss);
    h.defRtg = a.offRtg; a.defRtg = h.offRtg;
    h.netRtg = h.offRtg - h.defRtg; a.netRtg = a.offRtg - a.defRtg;
    const hasShots = H.fga + A.fga > 0;
    return { raw: { home: H, away: A }, home: h, away: a, avgPoss, hasShots, hasFouls: !!pf };
  }

  const calc = { periods, roundEg10, series, flowStats, quarterTable, parseStat, flatStats, findStat, teamMetrics, REF };

  // ── çizim (yalnızca tarayıcı) ───────────────────────────────────────────
  if (typeof document === 'undefined') return { calc };

  const $ = (id) => document.getElementById(id);
  const C = { home: '#60a5fa', away: '#f87171', total: '#f59e0b', grid: 'rgba(255,255,255,0.05)', tick: '#6c7280', good: '#22c55e' };
  const charts = {};
  let tableMode = 'raw';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const fmt = (x, d = 1) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(d));
  const pct = (x, d = 0) => (x == null || !isFinite(x) ? '—' : `%${(x * 100).toFixed(d)}`);
  const minLabel = (m) => {
    if (!m) return '—';
    if (m <= 40) return `Ç${Math.ceil(m / 10)} ${((m - 1) % 10) + 1}'`;
    return `U${Math.ceil((m - 40) / 5)} ${((m - 41) % 5) + 1}'`;
  };

  function chart(id, config) {
    if (!window.Chart) return;
    const c = charts[id];
    if (c && c.config.type === config.type) {
      c.data = config.data;
      c.update('none');
      return;
    }
    if (c) c.destroy();
    const base = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { labels: { color: '#a3a8b3', boxWidth: 12, font: { size: 11 } } },
        tooltip: { backgroundColor: 'rgba(18,20,26,0.96)', borderColor: '#2f333d', borderWidth: 1 },
      },
    };
    const axes = { ticks: { color: C.tick }, grid: { color: C.grid } };
    if (config.type !== 'radar') base.scales = { x: { ...axes }, y: { ...axes } };
    charts[id] = new Chart($(id), { ...config, options: deepMerge(base, config.options || {}) });
  }

  function deepMerge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
    return out;
  }

  // ── görünümler ──────────────────────────────────────────────────────────
  function renderSummary(s) {
    const sr = series(s);
    const done = Math.max(0, sr.L - 1);   // tamamlanmış dakikalar
    const f = flowStats(sr, sr.L);
    const hn = s.homeName || 'Ev', an = s.awayName || 'Dep';
    const kp = $('sumKpis');
    kp.replaceChildren();
    const card = (k, v, sub, cls) => {
      const d = el('div', 'kpi' + (cls ? ' ' + cls : ''));
      d.append(el('div', 'k', k), el('div', 'v mono', v));
      if (sub) d.append(el('div', 's', sub));
      kp.append(d);
    };
    card('En büyük fark · ' + short(hn), f.maxH.v ? `+${f.maxH.v}` : '—', f.maxH.m ? minLabel(f.maxH.m) : 'hiç önde değil', 'home');
    card('En büyük fark · ' + short(an), f.maxA.v ? `+${f.maxA.v}` : '—', f.maxA.m ? minLabel(f.maxA.m) : 'hiç önde değil', 'away');
    card('Liderlik değişimi', String(f.leadChanges), 'dakika sonlarına göre');
    card('Beraberlik', String(f.ties), 'dakika sonunda eşit');
    card('En iyi dakika (toplam)', f.bestT.v ? String(f.bestT.v) : '—', minLabel(f.bestT.m));
    const firstHalf = sr.cumH[Math.min(19, sr.L - 1)] + sr.cumA[Math.min(19, sr.L - 1)];
    card('Tempo (dakika başı)', fmt((sr.cumH[sr.L - 1] + sr.cumA[sr.L - 1] - sr.startH - sr.startA) / Math.max(1, sr.L), 2),
      `EuroLeague/EuroCup ort. ${fmt(REF.quarterMean.reduce((x, y) => x + y) / 40, 2)}`);
    if (sr.L >= 20) card('İlk yarı', String(firstHalf), `ort. ${fmt(REF.quarterMean[0] + REF.quarterMean[1], 1)}`);

    // çeyrek tablosu
    const q = quarterTable(s, sr);
    const t = $('sumQuarters');
    t.replaceChildren();
    const head = el('tr');
    ['', short(hn), short(an), 'Toplam', 'Fark', 'Dk başı', 'Ort.'].forEach((x) => head.append(el('th', '', x)));
    t.append(head);
    let H1 = 0, A1 = 0, H2 = 0, A2 = 0;
    q.forEach((r, i) => {
      if (i < 2) { H1 += r.h; A1 += r.a; } else { H2 += r.h; A2 += r.a; }
      const tr = el('tr', r.done ? '' : 'live');
      const diff = r.h - r.a;
      tr.append(el('td', 'lbl', r.short + (r.done ? '' : ` (${r.played}')`)), el('td', 'mono home', r.h), el('td', 'mono away', r.a),
        el('td', 'mono b', r.t), el('td', 'mono ' + (diff > 0 ? 'home' : diff < 0 ? 'away' : ''), (diff > 0 ? '+' : '') + diff),
        el('td', 'mono', fmt(r.pace, 2)), el('td', 'mono dim', r.ref ? fmt(r.ref, 1) : '—'));
      t.append(tr);
    });
    const half = (lbl, hh, aa) => {
      const tr = el('tr', 'sum');
      tr.append(el('td', 'lbl', lbl), el('td', 'mono home', hh), el('td', 'mono away', aa), el('td', 'mono b', hh + aa),
        el('td', 'mono', (hh - aa > 0 ? '+' : '') + (hh - aa)), el('td', ''), el('td', ''));
      t.append(tr);
    };
    if (q.length >= 2) half('1. yarı', H1, A1);
    if (q.length >= 3) half('2. yarı' + (q.length > 4 ? ' + U' : ''), H2, A2);
    $('sumQuartersNote').textContent = `"Ort." = ${REF.games} EuroLeague/EuroCup maçında o çeyreğin ortalama toplamı.`;

    // seriler
    const box = $('sumRuns');
    box.replaceChildren();
    const row = (k, v, sub, cls) => {
      const r = el('div', 'kv');
      const left = el('div', '');
      left.append(el('div', 'k ' + (cls || ''), k));
      if (sub) left.append(el('div', 's', sub));
      r.append(left, el('div', 'v mono', v));
      box.append(r);
    };
    const run = (r) => (r.pts ? `${r.pts}-0` : '—');
    row(`En uzun seri · ${short(hn)}`, run(f.runs.home), f.runs.home.pts ? `${minLabel(f.runs.home.from)} – ${minLabel(f.runs.home.to)}` : '', 'home');
    row(`En uzun seri · ${short(an)}`, run(f.runs.away), f.runs.away.pts ? `${minLabel(f.runs.away.from)} – ${minLabel(f.runs.away.to)}` : '', 'away');
    row(`En uzun sayısız dönem · ${short(hn)}`, f.droughtH.len ? `${f.droughtH.len} dk` : '—', f.droughtH.len ? `${minLabel(f.droughtH.from)} – ${minLabel(f.droughtH.to)}` : '', 'home');
    row(`En uzun sayısız dönem · ${short(an)}`, f.droughtA.len ? `${f.droughtA.len} dk` : '—', f.droughtA.len ? `${minLabel(f.droughtA.from)} – ${minLabel(f.droughtA.to)}` : '', 'away');
    row(`En iyi dakika · ${short(hn)}`, f.bestH.v ? String(f.bestH.v) : '—', minLabel(f.bestH.m), 'home');
    row(`En iyi dakika · ${short(an)}`, f.bestA.v ? String(f.bestA.v) : '—', minLabel(f.bestA.m), 'away');
    void done;

    marginChart('cMarginSum', sr, hn, an);
  }

  function short(name) {
    const w = String(name || '').trim().split(/\s+/);
    const s = w[0] && w[0].length <= 3 && w[1] ? `${w[0]} ${w[1]}` : (w[0] || '?');
    return s.length > 14 ? s.slice(0, 13) + '…' : s;
  }

  function labels(sr) { return Array.from({ length: sr.L }, (_, i) => i + 1); }

  function marginChart(id, sr, hn, an) {
    chart(id, {
      type: 'bar',
      data: {
        labels: labels(sr),
        datasets: [{
          label: 'Fark', data: sr.margin,
          backgroundColor: sr.margin.map((d) => (d >= 0 ? 'rgba(96,165,250,0.7)' : 'rgba(248,113,113,0.7)')),
          borderRadius: 2,
        }],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (i) => minLabel(+i[0].label),
          label: (i) => (i.raw > 0 ? `${short(hn)} +${i.raw}` : i.raw < 0 ? `${short(an)} +${-i.raw}` : 'Berabere'),
        } } },
      },
    });
  }

  function renderFlow(s) {
    const sr = series(s);
    const hn = s.homeName || 'Ev', an = s.awayName || 'Dep';
    const lab = labels(sr);
    const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color + '33', borderWidth: 2, pointRadius: 0, tension: 0.25, ...extra });
    chart('cPerMin', {
      type: 'bar',
      data: { labels: lab, datasets: [
        { label: hn, data: sr.h, backgroundColor: 'rgba(96,165,250,0.75)', borderRadius: 2 },
        { label: an, data: sr.a, backgroundColor: 'rgba(248,113,113,0.75)', borderRadius: 2 },
      ] },
      options: { plugins: { tooltip: { callbacks: { title: (i) => minLabel(+i[0].label) } } } },
    });
    chart('cMomentum', {
      type: 'line',
      data: { labels: lab, datasets: [{
        label: 'Momentum', data: sr.momentum, borderWidth: 2, pointRadius: 0, tension: 0.35,
        borderColor: '#a3a8b3',
        fill: { target: 'origin', above: 'rgba(96,165,250,0.35)', below: 'rgba(248,113,113,0.35)' },
      }] },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: (i) => minLabel(+i[0].label),
        label: (i) => (i.raw > 0 ? `${short(hn)} son 3 dk +${i.raw}` : i.raw < 0 ? `${short(an)} son 3 dk +${-i.raw}` : 'Eşit'),
      } } } },
    });
    chart('cCum', { type: 'line', data: { labels: lab, datasets: [line(hn, sr.cumH, C.home), line(an, sr.cumA, C.away)] },
      options: { plugins: { tooltip: { mode: 'index', intersect: false, callbacks: { title: (i) => minLabel(+i[0].label) } } } } });
    marginChart('cMargin', sr, hn, an);
    chart('cPace', {
      type: 'line',
      data: { labels: lab, datasets: [
        line('EG10 (çeyrek içi projeksiyon)', sr.eg10, C.total, { fill: true }),
        line('×40 (o dakikanın temposu)', sr.x40, '#a3a8b3', { borderWidth: 1, borderDash: [4, 3] }),
      ] },
      options: { plugins: { tooltip: { mode: 'index', intersect: false } } },
    });
    chart('cRolling', {
      type: 'line',
      data: { labels: lab, datasets: [line('Son 5 dk temposu (maça yayılmış)', sr.rolling, C.good, { fill: true }),
        line('EuroLeague/EuroCup ortalaması', lab.map(() => 164.4), '#6c7280', { borderDash: [6, 4], borderWidth: 1 })] },
      options: { plugins: { tooltip: { mode: 'index', intersect: false } } },
    });
  }

  function renderTables(s) {
    const sr = series(s);
    const notes = {
      raw: 'Her hücre o dakikada atılan sayı.',
      x40: 'Hücre × 40: o dakikanın temposu maça yayılmış hâli.',
      eg10: 'EG10: çeyreğin başından o dakikaya kadarki sayı × (40 / geçen dakika). Küsurat ≥ 0,7 ise yukarı yuvarlanır.',
      cum: 'Dakika sonundaki toplam skor.',
    };
    $('tableModeNote').textContent = notes[tableMode];
    const box = $('scoreTables');
    box.replaceChildren();
    const hn = s.homeName || 'Ev sahibi', an = s.awayName || 'Deplasman';
    const val = (side, m) => {
      const arr = side === 'h' ? sr.h : side === 'a' ? sr.a : sr.tot;
      if (tableMode === 'raw') return arr[m - 1];
      if (tableMode === 'x40') return arr[m - 1] * 40;
      if (tableMode === 'cum') return side === 'h' ? sr.cumH[m - 1] : side === 'a' ? sr.cumA[m - 1] : sr.cumH[m - 1] + sr.cumA[m - 1];
      // eg10 per side
      const p = periods(s.totalCells).find((x) => m >= x.from && m <= x.to);
      let cum = 0;
      for (let k = p.from; k <= m; k++) cum += arr[k - 1];
      return roundEg10(cum * (40 / (m - p.from + 1)));
    };
    for (const [side, title, cls] of [['h', hn, 'home'], ['t', 'Toplam', 'total'], ['a', an, 'away']]) {
      const card = el('div', 'mini ' + cls);
      card.append(el('div', 'mini-title', title));
      const grid = el('div', 'minute-grid');
      const head = el('div', 'mg-row mg-head');
      head.append(el('div', 'mg-lbl', ''));
      for (let i = 1; i <= 10; i++) head.append(el('div', 'mg-cell', `${i}'`));
      head.append(el('div', 'mg-sum mg-lbl', tableMode === 'raw' ? 'Top.' : ''));
      grid.append(head);
      let max = 1;
      for (let m = 1; m <= sr.L; m++) max = Math.max(max, Number(val(side, m)) || 0);
      for (const p of periods(s.totalCells)) {
        const row = el('div', 'mg-row');
        row.append(el('div', 'mg-lbl', p.short));
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          const m = p.from + i;
          if (m > p.to) { row.append(el('div', 'mg-cell blank')); continue; }
          const played = m <= sr.L;
          const v = played ? val(side, m) : '';
          if (played) sum += side === 'h' ? sr.h[m - 1] : side === 'a' ? sr.a[m - 1] : sr.tot[m - 1];
          const c = el('div', 'mg-cell' + (played ? ' has' : '') + (m === sr.L ? ' cur' : ''), played ? String(v) : '');
          c.title = `${minLabel(m)}`;
          if (played && v && tableMode !== 'cum') c.style.background = `${cls === 'home' ? 'rgba(96,165,250,' : cls === 'away' ? 'rgba(248,113,113,' : 'rgba(245,158,11,'}${Math.min(0.5, (v / max) * 0.5)})`;
          row.append(c);
        }
        row.append(el('div', 'mg-sum', p.from <= sr.L && tableMode === 'raw' ? String(sum) : ''));
        grid.append(row);
      }
      card.append(grid);
      box.append(card);
    }
  }

  function renderTeam(s, extra) {
    // EuroLeague/EuroCup: resmi kutu skoru varsa onu kullan (Flashscore'dan daha eksiksiz)
    const official = extra && extra.box && !extra.box.demo ? boxSections(extra.box) : null;
    const tm = teamMetrics(official || s.stats, s.homeScore, s.awayScore);
    const hn = s.homeName || 'Ev', an = s.awayName || 'Dep';
    const box = $('teamCompare');
    box.replaceChildren();
    if (!tm.hasShots) {
      box.append(el('div', 'empty', 'Flashscore bu maç için henüz şut istatistiği yayınlamadı. İstatistikler gelince (30 sn\'de bir yenilenir) bu bölüm dolar.'));
    }
    const head = el('div', 'cmp-head');
    head.append(el('div', 'home', hn), el('div', ''), el('div', 'away', an));
    box.append(head);
    const rows = [
      ['Sahadan %', tm.home.fgPct, tm.away.fgPct, pct, `${tm.raw.home.fgm}/${tm.raw.home.fga}`, `${tm.raw.away.fgm}/${tm.raw.away.fga}`],
      ['2 sayı %', tm.home.fg2Pct, tm.away.fg2Pct, pct, `${tm.raw.home.fg2m}/${tm.raw.home.fg2a}`, `${tm.raw.away.fg2m}/${tm.raw.away.fg2a}`],
      ['3 sayı %', tm.home.fg3Pct, tm.away.fg3Pct, pct, `${tm.raw.home.fg3m}/${tm.raw.home.fg3a}`, `${tm.raw.away.fg3m}/${tm.raw.away.fg3a}`],
      ['Serbest atış %', tm.home.ftPct, tm.away.ftPct, pct, `${tm.raw.home.ftm}/${tm.raw.home.fta}`, `${tm.raw.away.ftm}/${tm.raw.away.fta}`],
      ['eFG%', tm.home.efg, tm.away.efg, pct],
      ['True Shooting %', tm.home.ts, tm.away.ts, pct],
      ['Top kaybı oranı (düşük iyi)', tm.home.tovPct, tm.away.tovPct, pct, null, null, true],
      ['Hücum ribaundu %', tm.home.orbPct, tm.away.orbPct, pct],
      ['Serbest atış oranı (FTA/FGA)', tm.home.ftr, tm.away.ftr, (x) => fmt(x, 2)],
      ['3 sayı deneme payı', tm.home.threeRate, tm.away.threeRate, pct],
      ['Asist / top kaybı', tm.home.astTov, tm.away.astTov, (x) => fmt(x, 2)],
      ['Asistli basket payı', tm.home.astRate, tm.away.astRate, pct],
      ['Hücum sayısı (tahmini)', tm.home.poss, tm.away.poss, (x) => fmt(x, 1)],
      ['Hücum verimi (100 hücumda)', tm.home.offRtg, tm.away.offRtg, (x) => fmt(x, 1)],
      ['Net verim', tm.home.netRtg, tm.away.netRtg, (x) => (x > 0 ? '+' : '') + fmt(x, 1)],
      ['Ribaund', tm.raw.home.reb, tm.raw.away.reb, (x) => fmt(x, 0)],
      ['Asist', tm.raw.home.ast, tm.raw.away.ast, (x) => fmt(x, 0)],
      ['Top çalma', tm.raw.home.stl, tm.raw.away.stl, (x) => fmt(x, 0)],
      ['Blok', tm.raw.home.blk, tm.raw.away.blk, (x) => fmt(x, 0)],
      ['Top kaybı (düşük iyi)', tm.raw.home.tov, tm.raw.away.tov, (x) => fmt(x, 0), null, null, true],
    ];
    if (tm.hasFouls) rows.push(['Faul (düşük iyi)', tm.raw.home.pf, tm.raw.away.pf, (x) => fmt(x, 0), null, null, true]);
    for (const [k, hv, av, f, hs, as, lowGood] of rows) box.append(cmpRow(k, hv, av, f, hs, as, lowGood));
    $('teamNote').textContent = 'Formüller: eFG% = (FGM + 0,5·3PM)/FGA · TS% = PTS / (2·(FGA + 0,44·FTA)) · hücum = FGA − ORB + TOV + 0,44·FTA. Kaynak: ' +
      (official ? 'EuroLeague resmi kutu skoru.' : 'Flashscore takım istatistikleri.');

    chart('cRadar', {
      type: 'radar',
      data: { labels: ['eFG%', 'Top koruma (1−TOV%)', 'Hücum rib. %', 'FTA/FGA'], datasets: [
        { label: hn, data: [tm.home.efg, 1 - tm.home.tovPct, tm.home.orbPct, Math.min(1, tm.home.ftr)], borderColor: C.home, backgroundColor: 'rgba(96,165,250,0.18)', pointRadius: 3 },
        { label: an, data: [tm.away.efg, 1 - tm.away.tovPct, tm.away.orbPct, Math.min(1, tm.away.ftr)], borderColor: C.away, backgroundColor: 'rgba(248,113,113,0.18)', pointRadius: 3 },
      ] },
      options: { scales: { r: { min: 0, max: 1, angleLines: { color: C.grid }, grid: { color: C.grid }, pointLabels: { color: '#a3a8b3', font: { size: 11 } }, ticks: { display: false } } } },
    });
    chart('cRatings', {
      type: 'bar',
      data: { labels: ['Hücum verimi', 'Savunma verimi (düşük iyi)', 'Net'], datasets: [
        { label: hn, data: [tm.home.offRtg, tm.home.defRtg, tm.home.netRtg], backgroundColor: 'rgba(96,165,250,0.75)', borderRadius: 3 },
        { label: an, data: [tm.away.offRtg, tm.away.defRtg, tm.away.netRtg], backgroundColor: 'rgba(248,113,113,0.75)', borderRadius: 3 },
      ] },
    });
    const R = tm.raw;
    chart('cShots', {
      type: 'bar',
      data: { labels: [short(hn), short(an)], datasets: [
        { label: '2 sayı isabet', data: [R.home.fg2m, R.away.fg2m], backgroundColor: '#22c55e', stack: 's' },
        { label: '2 sayı kaçan', data: [R.home.fg2a - R.home.fg2m, R.away.fg2a - R.away.fg2m], backgroundColor: 'rgba(34,197,94,0.25)', stack: 's' },
        { label: '3 sayı isabet', data: [R.home.fg3m, R.away.fg3m], backgroundColor: '#f59e0b', stack: 's' },
        { label: '3 sayı kaçan', data: [R.home.fg3a - R.home.fg3m, R.away.fg3a - R.away.fg3m], backgroundColor: 'rgba(245,158,11,0.25)', stack: 's' },
        { label: 'Serbest atış isabet', data: [R.home.ftm, R.away.ftm], backgroundColor: '#60a5fa', stack: 's' },
        { label: 'Serbest atış kaçan', data: [R.home.fta - R.home.ftm, R.away.fta - R.away.ftm], backgroundColor: 'rgba(96,165,250,0.25)', stack: 's' },
      ] },
      options: { indexAxis: 'y', scales: { x: { stacked: true }, y: { stacked: true } } },
    });
    chart('cSources', {
      type: 'bar',
      data: { labels: [short(hn), short(an)], datasets: [
        { label: '2 sayılık', data: [tm.home.pts2, tm.away.pts2], backgroundColor: '#22c55e', stack: 'p' },
        { label: '3 sayılık', data: [tm.home.pts3, tm.away.pts3], backgroundColor: '#f59e0b', stack: 'p' },
        { label: 'Serbest atış', data: [tm.home.ptsFt, tm.away.ptsFt], backgroundColor: '#60a5fa', stack: 'p' },
      ] },
      options: { indexAxis: 'y', scales: { x: { stacked: true }, y: { stacked: true } } },
    });
  }

  function cmpRow(k, hv, av, f, hs, as, lowGood) {
    const r = el('div', 'cmp');
    const hNum = Number(hv) || 0, aNum = Number(av) || 0;
    const tot = Math.abs(hNum) + Math.abs(aNum);
    const better = hv == null || av == null || hNum === aNum ? 0 : (hNum > aNum) !== !!lowGood ? 1 : -1;
    const left = el('div', 'cmp-v home' + (better > 0 ? ' win' : ''));
    left.append(el('span', 'mono', f(hv)));
    if (hs) left.append(el('span', 'sub', hs));
    const right = el('div', 'cmp-v away' + (better < 0 ? ' win' : ''));
    right.append(el('span', 'mono', f(av)));
    if (as) right.append(el('span', 'sub', as));
    const mid = el('div', 'cmp-mid');
    mid.append(el('div', 'cmp-k', k));
    const bar = el('div', 'cmp-bar');
    const hb = el('div', 'hb'); const ab = el('div', 'ab');
    hb.style.width = tot ? `${(Math.abs(hNum) / tot) * 100}%` : '50%';
    ab.style.width = tot ? `${(Math.abs(aNum) / tot) * 100}%` : '50%';
    bar.append(hb, ab);
    mid.append(bar);
    r.append(left, mid, right);
    return r;
  }

  function renderStats(s) {
    const box = $('fullStats');
    box.replaceChildren();
    const sections = s.stats || [];
    if (!sections.length) {
      box.append(el('div', 'empty', 'Flashscore bu maç için henüz istatistik yayınlamadı (30 saniyede bir kontrol edilir).'));
      return;
    }
    const head = el('div', 'cmp-head');
    head.append(el('div', 'home', s.homeName || 'Ev'), el('div', ''), el('div', 'away', s.awayName || 'Dep'));
    box.append(head);
    for (const sec of sections) {
      if (sec.title) box.append(el('div', 'sec-title', sec.title));
      for (const r of sec.rows || []) {
        const h = parseStat(r.home), a = parseStat(r.away);
        const row = cmpRow(r.name, r.home, r.away, (x) => x ?? '—', null, null, /faul|foul|kayb|turnover/i.test(r.name));
        const hb = row.querySelector('.hb'), ab = row.querySelector('.ab');
        const hn = isFinite(h.num) ? h.num : 0, an = isFinite(a.num) ? a.num : 0;
        const t = hn + an;
        hb.style.width = t ? `${(hn / t) * 100}%` : '50%';
        ab.style.width = t ? `${(an / t) * 100}%` : '50%';
        if (/faul|foul/i.test(r.name)) row.classList.add('hl');
        box.append(row);
      }
    }
  }

  function renderHeat(s) {
    const sr = series(s);
    const box = $('heatMaps');
    box.replaceChildren();
    const hn = s.homeName || 'Ev sahibi', an = s.awayName || 'Deplasman';
    for (const [arr, title, rgb] of [[sr.h, hn, '96,165,250'], [sr.a, an, '248,113,113'], [sr.tot, 'Toplam', '245,158,11']]) {
      const max = Math.max(1, ...arr);
      const card = el('div', 'mini');
      card.append(el('div', 'mini-title', title));
      for (const p of periods(s.totalCells)) {
        const row = el('div', 'heat-row');
        row.append(el('div', 'mg-lbl', p.short));
        for (let i = 0; i < 10; i++) {
          const m = p.from + i;
          if (m > p.to) { row.append(el('div', 'heat-cell blank')); continue; }
          const v = m <= sr.L ? arr[m - 1] : null;
          const c = el('div', 'heat-cell', v ? String(v) : '');
          c.title = `${minLabel(m)}: ${v ?? '—'}`;
          if (v != null) c.style.background = `rgba(${rgb},${0.08 + (v / max) * 0.8})`;
          if (v != null && v / max > 0.55) c.style.color = '#0a0b0f';
          row.append(c);
        }
        card.append(row);
      }
      box.append(card);
    }
  }

  function renderPatterns(s) {
    const sr = series(s);
    const q = quarterTable(s, sr).filter((r) => r.from <= 40);
    const bars = $('qBars');
    bars.replaceChildren();
    const max = Math.max(1, ...q.map((r) => r.t), ...REF.quarterMean);
    for (const r of q) {
      const row = el('div', 'qbar');
      row.append(el('div', 'mg-lbl', r.short));
      const track = el('div', 'qbar-track');
      const hb = el('div', 'qh'); hb.style.width = `${(r.h / max) * 100}%`;
      const ab = el('div', 'qa'); ab.style.width = `${(r.a / max) * 100}%`;
      const ref = el('div', 'qref'); ref.style.left = `${(r.ref / max) * 100}%`; ref.title = `Ortalama ${r.ref}`;
      track.append(hb, ab, ref);
      row.append(track, el('div', 'mono qv', `${r.t}${r.done ? '' : '…'}`));
      bars.append(row);
    }
    bars.append(el('div', 'note', 'Mavi: ev sahibi, kırmızı: deplasman. Dikey çizgi: o çeyreğin EuroLeague/EuroCup ortalaması.'));

    const t = q.map((r) => (r.done ? r.t : null));
    const box = $('patternRules');
    box.replaceChildren();
    const rule = (title, state, text, stat) => {
      const d = el('div', 'rule');
      const top = el('div', 'rule-top');
      top.append(el('div', 'rule-title', title));
      const b = el('span', 'rule-badge', state.label);
      b.dataset.kind = state.kind;
      top.append(b);
      d.append(top, el('div', 'rule-text', text), el('div', 'rule-stat', stat));
      box.append(d);
    };
    const K = REF.kriter1;
    let st, txt;
    if (t[0] == null || t[1] == null) { st = { label: 'Bekleniyor', kind: 'wait' }; txt = 'İlk iki çeyrek tamamlanınca değerlendirilir.'; }
    else if (!(t[1] > t[0])) { st = { label: 'Koşul yok', kind: 'off' }; txt = `Ç2 (${t[1]}) > Ç1 (${t[0]}) değil.`; }
    else if (t[2] == null || t[3] == null) {
      st = { label: 'Koşul aktif', kind: 'on' };
      const floor = t[2] != null ? t[0] + t[1] + 2 * t[2] : null;
      txt = `Ç2 (${t[1]}) > Ç1 (${t[0]}). Kural Ç4 ≥ Ç3 bekler${floor ? `; taban Ç1+Ç2+2·Ç3 = ${floor}` : ''}.`;
    } else {
      const ok = t[3] >= t[2];
      st = ok ? { label: 'Tuttu', kind: 'ok' } : { label: 'Tutmadı', kind: 'bad' };
      txt = `Ç3 ${t[2]}, Ç4 ${t[3]}.`;
    }
    rule('Kriter 1 · Ç2 > Ç1 ise Ç4 ≥ Ç3', st, txt,
      `Gerçek veri: koşul varken %${Math.round(K.cond * 100)}, yokken %${Math.round(K.other * 100)} (genel %${Math.round(K.base * 100)}). Koşul bilgi taşımıyor; iddia edilen %95 tutmuyor.`);

    const D = REF.decline;
    if (t[0] == null || t[1] == null) { st = { label: 'Bekleniyor', kind: 'wait' }; txt = 'İlk iki çeyrek tamamlanınca değerlendirilir.'; }
    else if (!(t[0] > t[1])) { st = { label: 'Koşul yok', kind: 'off' }; txt = `Ç1 (${t[0]}) > Ç2 (${t[1]}) değil.`; }
    else if (t[2] == null || t[3] == null) { st = { label: 'Koşul aktif', kind: 'on' }; txt = `Ç1 (${t[0]}) > Ç2 (${t[1]}). Kural Ç3 > Ç4 bekler.`; }
    else { const ok = t[2] > t[3]; st = ok ? { label: 'Tuttu', kind: 'ok' } : { label: 'Tutmadı', kind: 'bad' }; txt = `Ç3 ${t[2]}, Ç4 ${t[3]}.`; }
    rule('Düzenli düşüş · Ç1 > Ç2 ise Ç3 > Ç4', st, txt,
      `Gerçek veri: koşul varken %${Math.round(D.cond * 100)}, yokken %${Math.round(D.other * 100)} (genel %${Math.round(D.base * 100)}). Son çeyrek genelde daha yüksek skorlu.`);
  }


  // ── Oyuncular (resmi EuroLeague / EuroCup verisi) ───────────────────────
  const sortState = { home: { key: 'pts', dir: -1 }, away: { key: 'pts', dir: -1 } };
  const BOX_COLS = [
    ['no', '#'], ['name', 'Oyuncu'], ['min', 'Dk'], ['pts', 'Sayı'], ['fg2', '2S'], ['fg3', '3S'], ['ft', 'SA'],
    ['oreb', 'HR'], ['dreb', 'SR'], ['reb', 'Rib'], ['ast', 'Ast'], ['stl', 'TÇ'], ['tov', 'TK'], ['blk', 'Blk'],
    ['pf', 'Faul'], ['fd', 'FA'], ['pm', '+/-'], ['pir', 'PIR'],
  ];
  const BOX_TITLES = { min: 'Süre', fg2: 'İki sayılık', fg3: 'Üç sayılık', ft: 'Serbest atış', oreb: 'Hücum ribaundu',
    dreb: 'Savunma ribaundu', reb: 'Toplam ribaund', ast: 'Asist', stl: 'Top çalma', tov: 'Top kaybı', blk: 'Blok',
    pf: 'Yaptığı faul', fd: 'Kendisine yapılan faul', pm: 'Sahadayken skor farkı', pir: 'Performans endeksi (PIR)' };

  function boxSortValue(p, key) {
    if (key === 'fg2') return p.fg2m; if (key === 'fg3') return p.fg3m; if (key === 'ft') return p.ftm;
    if (key === 'name') return p.name; if (key === 'no') return Number(p.no) || 0;
    return p[key] == null ? -999 : p[key];
  }

  function boxTable(tableId, team, side, onSort) {
    const t = $(tableId);
    t.replaceChildren();
    const head = el('tr');
    for (const [k, label] of BOX_COLS) {
      const th = el('th', k === 'name' ? 'l' : '', label);
      th.title = BOX_TITLES[k] || '';
      if (sortState[side].key === k) th.classList.add('sorted');
      th.addEventListener('click', () => {
        const st = sortState[side];
        st.dir = st.key === k ? -st.dir : (k === 'name' || k === 'no' ? 1 : -1);
        st.key = k;
        onSort();
      });
      head.append(th);
    }
    t.append(head);
    const { key, dir } = sortState[side];
    const rows = team.players.slice().sort((a, b) => {
      const x = boxSortValue(a, key), y = boxSortValue(b, key);
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    });
    const best = {};
    for (const k of ['pts', 'reb', 'ast', 'pir']) best[k] = Math.max(...team.players.map((p) => p[k] || 0));
    for (const p of rows) {
      const tr = el('tr', p.min === 0 ? 'dnp' : '');
      const cell = (txt, cls) => tr.append(el('td', 'mono ' + (cls || ''), txt));
      cell(p.no || '');
      const name = el('td', 'l pname');
      if (p.onCourt) name.append(el('span', 'dot-on'));
      name.append(el('span', '', p.name + (p.starter ? ' *' : '')));
      tr.append(name);
      cell(p.min ? p.minText.replace(/^0/, '') : '—', 'dim');
      cell(p.pts, 'b' + (p.pts && p.pts === best.pts ? ' top' : ''));
      cell(`${p.fg2m}/${p.fg2a}`, 'dim'); cell(`${p.fg3m}/${p.fg3a}`, 'dim'); cell(`${p.ftm}/${p.fta}`, 'dim');
      cell(p.oreb); cell(p.dreb); cell(p.reb, p.reb && p.reb === best.reb ? 'top' : '');
      cell(p.ast, p.ast && p.ast === best.ast ? 'top' : ''); cell(p.stl); cell(p.tov); cell(p.blk);
      cell(p.pf, p.pf >= 5 ? 'pf5' : p.pf === 4 ? 'pf4' : ''); cell(p.fd);
      cell(p.pm == null ? '—' : (p.pm > 0 ? '+' : '') + p.pm, p.pm > 0 ? 'pos' : p.pm < 0 ? 'neg' : '');
      cell(p.pir, p.pir && p.pir === best.pir ? 'top' : '');
      t.append(tr);
    }
    if (team.totals) {
      const T = team.totals, tr = el('tr', 'sum');
      const cell = (txt, cls) => tr.append(el('td', 'mono ' + (cls || ''), txt));
      cell(''); tr.append(el('td', 'l', 'Takım'));
      cell(''); cell(T.pts, 'b'); cell(`${T.fg2m}/${T.fg2a}`); cell(`${T.fg3m}/${T.fg3a}`); cell(`${T.ftm}/${T.fta}`);
      cell(T.oreb); cell(T.dreb); cell(T.reb + (team.teamReb || 0)); cell(T.ast); cell(T.stl); cell(T.tov); cell(T.blk);
      cell(T.pf); cell(T.fd); cell(''); cell(T.pir);
      t.append(tr);
    }
  }

  function renderPlayers(s, extra) {
    const box = extra && extra.box;
    const cards = document.querySelectorAll('[data-view="players"]');
    const empty = $('playersEmpty');
    if (!box) {
      cards.forEach((c) => { if (c !== empty) c.hidden = true; });
      empty.hidden = false;
      $('playersEmptyText').textContent = (extra && extra.supported === false)
        ? 'Oyuncu istatistikleri resmi EuroLeague/EuroCup verisinden gelir; bu lig için yok.'
        : 'Resmi EuroLeague/EuroCup verisi bekleniyor… Maç eşleşince oyuncu istatistikleri burada görünür (20 saniyede bir yenilenir).';
      return;
    }
    cards.forEach((c) => { c.hidden = false; });
    if (!box.demo) empty.hidden = true;
    else $('playersEmptyText').textContent = 'DEMO: oyuncu tablosu maçın resmi son kutu skorudur; takım faulleri ve olaylar maçın o anki dakikasına kadar gösterilir.';

    const teams = [['home', box.home], ['away', box.away]];
    // takım faulleri
    const tf = $('teamFouls');
    tf.replaceChildren();
    for (const [side, t] of teams) {
      const row = el('div', 'tf');
      const top = el('div', 'tf-top');
      top.append(el('div', 'tf-name ' + side, t.name));
      const b = el('span', 'rule-badge', t.fouls.bonus ? 'BONUS' : `${Math.max(0, 4 - t.fouls.current)} faul daha → bonus`);
      b.dataset.kind = t.fouls.bonus ? 'bad' : 'off';
      top.append(b);
      const dots = el('div', 'tf-dots');
      for (let i = 1; i <= 5; i++) dots.append(el('span', 'tf-dot' + (i <= t.fouls.current ? ' on' : '') + (i === 5 && t.fouls.current >= 5 ? ' over' : '')));
      dots.append(el('span', 'mono tf-n', String(t.fouls.current)));
      const per = el('div', 'tf-per');
      t.fouls.byPeriod.forEach((n, i) => per.append(el('span', i === box.period - 1 ? 'cur' : '', `${i < 4 ? 'Ç' + (i + 1) : 'U' + (i - 3)}: ${n}`)));
      row.append(top, dots, per);
      tf.append(row);
    }
    tf.append(el('div', 'note', 'FIBA: bir periyotta 4 takım faulünden sonraki her faulde rakip serbest atış kullanır. Uzatmalar 4. çeyreğin sayımıyla devam eder.'));

    // öne çıkanlar
    const lead = $('leaders');
    lead.replaceChildren();
    for (const [k, label] of [['pts', 'Sayı'], ['reb', 'Ribaund'], ['ast', 'Asist'], ['pir', 'PIR']]) {
      const col = el('div', 'lead');
      col.append(el('div', 'k', label));
      for (const [side, t] of teams) {
        const p = t.players.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0))[0];
        const r = el('div', 'lead-row ' + side);
        r.append(el('span', 'lead-name', p ? p.name : '—'), el('span', 'mono lead-v', p ? String(p[k]) : '—'));
        col.append(r);
      }
      lead.append(col);
    }

    $('boxTitleHome').textContent = `${box.home.name} · ${box.home.coach || ''}`;
    $('boxTitleAway').textContent = `${box.away.name} · ${box.away.coach || ''}`;
    const redraw = () => { boxTable('boxHome', box.home, 'home', redraw); boxTable('boxAway', box.away, 'away', redraw); };
    redraw();

    // faul sıkıntısı: 4+ faul, ya da ilk yarıda 3 faul
    const ft = $('foulTrouble');
    ft.replaceChildren();
    const half1 = (box.period || 0) <= 2;
    const trouble = [];
    for (const [side, t] of teams) for (const p of t.players) {
      if (p.pf >= 4 || (half1 && p.pf >= 3)) trouble.push({ side, p });
    }
    trouble.sort((a, b) => b.p.pf - a.p.pf || b.p.pts - a.p.pts);
    if (!trouble.length) ft.append(el('div', 'note', 'Faul sıkıntısında oyuncu yok (4+ faul, ya da ilk yarıda 3 faul).'));
    for (const { side, p } of trouble) {
      const r = el('div', 'kv');
      const left = el('div', '');
      left.append(el('div', 'k ' + side, p.name + (p.onCourt ? ' · sahada' : '')), el('div', 's', `${p.pts} sayı · ${p.minText} dk`));
      r.append(left, el('div', 'v mono ' + (p.pf >= 5 ? 'pf5' : 'pf4'), p.pf >= 5 ? 'oyundan çıktı (5)' : `${p.pf} faul`));
      ft.append(r);
    }

    // son olaylar
    const feed = $('feed');
    feed.replaceChildren();
    for (const e of box.events) {
      const r = el('div', 'ev ' + (e.side || '') + (e.scoring ? ' score' : '') + (/Faul|faul/.test(e.text) && e.type !== 'RV' ? ' foul' : ''));
      r.append(el('span', 'mono ev-t', e.minute ? `${minLabel(e.minute)} ${e.clock}` : e.clock));
      const txt = el('span', 'ev-x');
      txt.append(el('b', '', e.text), document.createTextNode(e.player ? ' · ' + e.player : ''));
      r.append(txt, el('span', 'mono ev-s', e.score || ''));
      feed.append(r);
    }
  }

  /** Official box totals → Flashscore-like stat sections (used by Takım analizi when available). */
  function boxSections(box) {
    const r = (name, h, a) => ({ name, home: String(h), away: String(a) });
    const H = box.home.totals, A = box.away.totals;
    if (!H || !A) return null;
    return [{ title: 'EuroLeague resmi kutu skoru', rows: [
      r('Alan Golü', `${H.fg2m + H.fg3m}/${H.fg2a + H.fg3a}`, `${A.fg2m + A.fg3m}/${A.fg2a + A.fg3a}`),
      r('İki Sayılık', `${H.fg2m}/${H.fg2a}`, `${A.fg2m}/${A.fg2a}`), r('Üç Sayılık', `${H.fg3m}/${H.fg3a}`, `${A.fg3m}/${A.fg3a}`),
      r('Serbest Atış', `${H.ftm}/${H.fta}`, `${A.ftm}/${A.fta}`), r('Hücum Ribaundu', H.oreb, A.oreb),
      r('Savunma Ribaundu', H.dreb, A.dreb), r('Toplam Ribaund', H.reb + (box.home.teamReb || 0), A.reb + (box.away.teamReb || 0)),
      r('Asist', H.ast, A.ast), r('Top Kaybı', H.tov, A.tov), r('Top Çalma', H.stl, A.stl), r('Blok', H.blk, A.blk),
      r('Fauller', H.pf, A.pf),
    ] }];
  }

  const views = { players: renderPlayers, summary: renderSummary, flow: renderFlow, tables: renderTables, team: renderTeam, stats: renderStats, heat: renderHeat, patterns: renderPatterns };

  function render(view, state, extra) {
    if (!state || !views[view]) return;
    try { views[view](state, extra || {}); } catch (e) { console.error('analysis view', view, e); }
  }

  function bindTableMode(onChange) {
    const seg = $('tableMode');
    if (!seg) return;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      tableMode = b.dataset.mode;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onChange();
    });
  }

  return { calc, render, bindTableMode, boxSections, views: Object.keys(views) };
});
