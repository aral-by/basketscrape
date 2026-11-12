/* BasketScrape panel: live score + full-time total prediction (eb_plus model).
 * Several matches are watched at once; each has a tab and the panel shows the selected one. */
(() => {
  'use strict';
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const { probOver } = window.BasketPredictor;
  if (window.Chart) {
    Chart.defaults.font.family = "'Inter', -apple-system, 'Segoe UI', sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#a3a8b3';
  }

  const ui = {
    form: $('urlForm'), url: $('urlInput'), start: $('startBtn'), stop: $('stopBtn'),
    pill: $('statusPill'), pillText: $('statusText'),
    intro: $('introCard'), facts: $('modelFacts'),
    cards: ['scoreCard', 'heroCard', 'lineCard', 'chartCard', 'gridCard', 'modelCard'].map($),
    line: $('lineInput'), thr: $('thresholdSel'), seg: $('basisSeg'),
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('bs.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('bs.' + k, v); } catch { /* yok say */ } },
  };

  let model = null;       // /api/model
  const matches = new Map();   // id → { id, url, status, update, prediction, end, logs }
  let order = [];              // sekme sırası
  let selected = null;         // seçili maçın id'si
  let score = null;       // seçili maçın son scoreUpdate'i
  let pred = null;        // seçili maçın son prediction'ı
  let basis = store.get('basis', 'lock');
  let chart = null;

  ui.thr.value = store.get('thr', '0.8');
  setBasis(basis);

  // ── yardımcılar ─────────────────────────────────────────────────────────
  const fmt = (x, d = 1) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(d));
  const pct = (x) => (x == null || !isFinite(x) ? '—' : `%${Math.round(x * 100)}`);
  const Z80 = 1.2815515655446004;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function setStatus(state, text) {
    ui.pill.dataset.state = state;
    ui.pillText.textContent = text;
  }

  // ── görünümler: Tahmin + detaylı analiz bölümleri ────────────────────────
  const VIEWS = ['predict', 'summary', 'flow', 'tables', 'team', 'stats', 'heat', 'patterns'];
  let view = VIEWS.includes(store.get('view', 'predict')) ? store.get('view', 'predict') : 'predict';
  let matchShown = false;

  function showMatch(on) {
    matchShown = on;
    ui.intro.hidden = on;
    document.querySelectorAll('[data-view]').forEach((c) => {
      const v = c.dataset.view;
      c.hidden = !on || (v !== 'all' && v !== view);
    });
    $('viewTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
    if (on && view === 'predict') renderStats();
  }

  function renderView() {
    if (!matchShown || view === 'predict' || !score) return;
    window.BasketAnalysis.render(view, score);
  }

  $('viewTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    view = b.dataset.v;
    store.set('view', view);
    showMatch(!!matches.get(selected));
    if (view === 'predict') { renderChart(); if (chart) chart.resize(); }
    renderView();
  });
  window.BasketAnalysis.bindTableMode(renderView);

  function logLine({ at, msg }) {
    return `${new Date(at || Date.now()).toLocaleTimeString('tr-TR')}  ${msg}\n`;
  }

  function renderLog() {
    const m = matches.get(selected);
    $('log').textContent = m ? m.logs.slice().reverse().map(logLine).join('') : '';
  }

  function periodLabel(p) {
    if (!p) return '—';
    return p <= 4 ? `${p}. Çeyrek` : `${p - 4}. Uzatma`;
  }

  // ── maç ekle / kaldır ───────────────────────────────────────────────────
  ui.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = ui.url.value.trim();
    if (!url) return;
    ui.start.disabled = true;
    ui.start.textContent = 'Ekleniyor…';
    try {
      const res = await fetch('/api/matches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('error', body.error || 'Bağlantı hatası');
      } else {
        ui.url.value = '';
        select(body.id);
      }
    } catch {
      setStatus('error', 'Sunucuya ulaşılamadı');
    }
    ui.start.disabled = false;
    ui.start.textContent = '+ Maç ekle';
  });

  async function removeMatch(id) {
    if (!id) return;
    await fetch('/api/matches/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  }

  ui.stop.addEventListener('click', () => removeMatch(selected));

  ui.line.addEventListener('input', () => {
    if (selected) store.set('line.' + selected, ui.line.value);
    renderLine(); renderChart(); renderBand(); renderTabs();
  });
  document.querySelectorAll('.btn-step').forEach((b) => b.addEventListener('click', () => {
    const v = parseFloat(ui.line.value);
    const base = isFinite(v) ? v : Math.round(currentMix()?.meanReg ?? 160) + 0.5;
    ui.line.value = (base + Number(b.dataset.step)).toFixed(1).replace(/\.0$/, '');
    ui.line.dispatchEvent(new Event('input'));
  }));
  ui.thr.addEventListener('change', () => { store.set('thr', ui.thr.value); renderLine(); renderTabs(); });
  ui.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-basis]');
    if (b) { setBasis(b.dataset.basis); renderLine(); renderTabs(); }
  });

  function setBasis(b) {
    basis = b;
    store.set('basis', b);
    ui.seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.basis === b));
  }

  // ── maç durumu ──────────────────────────────────────────────────────────
  function statusOf(m) {
    const st = (m.status && m.status.status) || 'starting';
    if (m.end && m.end.reason !== 'error') return ['idle', 'Maç bitti'];
    if (st === 'running') return ['live', 'Canlı'];
    if (st === 'not_started') return ['waiting', 'Maç bekleniyor'];
    if (st === 'starting') return ['waiting', 'Bağlanıyor'];
    if (st === 'finished') return ['idle', 'Maç bitti'];
    if (st === 'error') return ['error', (m.status && m.status.message) || 'Hata'];
    return ['idle', 'Bekliyor'];
  }

  function upsert(snap) {
    const m = matches.get(snap.id) || { logs: [] };
    Object.assign(m, snap);
    m.logs = m.logs || [];
    matches.set(snap.id, m);
    if (!order.includes(snap.id)) order.push(snap.id);
    return m;
  }

  function select(id) {
    if (id && !matches.has(id)) { selected = id; return; }   // olay birazdan gelecek
    selected = id && matches.has(id) ? id : (order[0] || null);
    try { history.replaceState(null, '', selected ? '#' + selected : location.pathname); } catch { /* yok */ }
    const m = matches.get(selected);
    score = m ? m.update : null;
    pred = m ? m.prediction : null;
    ui.line.value = selected ? store.get('line.' + selected, '') : '';
    renderAll();
  }

  function renderAll() {
    const m = matches.get(selected);
    renderTabs();
    showMatch(!!m);
    ui.stop.hidden = !m;
    if (!m) {
      setStatus('idle', matches.size ? 'Bekliyor' : 'Maç yok');
      return;
    }
    const [st, text] = statusOf(m);
    setStatus(st, text);
    renderScore();
    renderGrid();
    renderStats();
    renderPrediction();
    renderLine();
    renderChart();
    renderModel();
    renderLog();
    renderView();
  }

  function refreshSelected(id) {
    const m = matches.get(id);
    if (!m) return false;
    if (id === selected) {
      score = m.update;
      pred = m.prediction;
      return true;
    }
    renderTabs();
    return false;
  }

  // ── socket olayları ─────────────────────────────────────────────────────
  socket.on('matches', ({ matches: list }) => {
    matches.clear();
    order = [];
    (list || []).forEach(upsert);
    const want = (location.hash || '').slice(1);
    select(matches.has(want) ? want : (matches.has(selected) ? selected : order[0] || null));
  });

  socket.on('match:added', (snap) => {
    upsert(snap);
    if (!selected || snap.id === selected) select(snap.id);
    else renderTabs();
  });

  socket.on('match:removed', ({ id }) => {
    matches.delete(id);
    order = order.filter((x) => x !== id);
    if (id === selected) select(order[order.length - 1] || null);
    else renderTabs();
  });

  socket.on('match:status', ({ id, status }) => {
    const m = matches.get(id);
    if (!m) return;
    m.status = status;
    if (refreshSelected(id)) renderAll();
  });

  socket.on('match:update', ({ id, state }) => {
    const m = matches.get(id);
    if (!m) return;
    m.update = state;
    if (refreshSelected(id)) {
      showMatch(true);
      renderScore();
      renderGrid();
      renderStats();
      renderTabs();
      renderView();
    }
  });

  socket.on('match:prediction', ({ id, prediction }) => {
    const m = matches.get(id);
    if (!m) return;
    m.prediction = prediction;
    if (refreshSelected(id)) {
      renderPrediction();
      renderLine();
      renderChart();
      renderModel();
      renderGrid();
      renderTabs();
    }
  });

  socket.on('match:end', ({ id, result }) => {
    const m = matches.get(id);
    if (!m) return;
    m.end = result;
    if (refreshSelected(id)) renderAll();
  });

  socket.on('match:log', ({ id, at, msg }) => {
    const m = matches.get(id);
    if (!m) return;
    m.logs.push({ at, msg });
    if (m.logs.length > 60) m.logs.shift();
    if (id === selected) $('log').textContent = logLine({ at, msg }) + $('log').textContent.slice(0, 20000);
  });

  // ── sekmeler ────────────────────────────────────────────────────────────
  function shortName(name) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    const first = w[0].length <= 3 && w[1] ? `${w[0]} ${w[1]}` : w[0];
    return first.length > 14 ? first.slice(0, 13) + '…' : first;
  }

  function tabBadge(m) {
    const p = m.prediction;
    if (!p || !p.available) return null;
    const L = parseFloat(store.get('line.' + m.id, ''));
    const thr = parseFloat(ui.thr.value);
    const ref = p.lock || (basis === 'live' ? p.now : null);
    if (!ref) return null;
    if (!isFinite(L)) return p.lock ? { kind: 'lock', text: `KİLİT ${Math.round(p.lock.mean)}` } : null;
    const q = probOver(ref.mix, L);
    const conf = Math.max(q, 1 - q);
    if (conf >= thr) return { kind: q >= 0.5 ? 'over' : 'under', text: `${q >= 0.5 ? 'ÜST' : 'ALT'} %${Math.round(conf * 100)}` };
    return { kind: 'pass', text: `PAS %${Math.round(conf * 100)}` };
  }

  function renderTabs() {
    const nav = $('tabs');
    nav.hidden = matches.size === 0;
    nav.replaceChildren();
    for (const id of order) {
      const m = matches.get(id);
      if (!m) continue;
      const u = m.update;
      const tab = el('button', 'tab' + (id === selected ? ' on' : ''));
      tab.type = 'button';
      tab.dataset.state = statusOf(m)[0];
      tab.title = m.url;
      tab.append(el('span', 'dot'));
      const names = u && u.homeName ? `${shortName(u.homeName)} – ${shortName(u.awayName)}` : 'Yeni maç';
      tab.append(el('span', 'tab-names', names));
      if (u) tab.append(el('span', 'tab-score', `${u.homeScore ?? 0}-${u.awayScore ?? 0}`));
      if (u && !m.end) tab.append(el('span', 'tab-min', u.period ? `${u.period <= 4 ? 'Ç' + u.period : 'U' + (u.period - 4)} ${u.minute || ''}'` : ''));
      if (m.end && m.end.reason !== 'error') tab.append(el('span', 'tab-min', 'MS'));
      const badge = tabBadge(m);
      if (badge) {
        const b = el('span', 'tab-badge', badge.text);
        b.dataset.kind = badge.kind;
        tab.append(b);
      }
      const x = el('span', 'tab-x', '×');
      x.title = 'Maçı kaldır';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeMatch(id); });
      tab.append(x);
      tab.addEventListener('click', () => select(id));
      nav.append(tab);
    }
  }

  // ── skor tabelası ───────────────────────────────────────────────────────
  function quarterSums(s) {
    const out = [];
    const n = s.totalCells || 40;
    for (let start = 0; start < n; ) {
      const len = start < 40 ? 10 : 5;
      let h = 0, a = 0;
      for (let i = start; i < start + len; i++) { h += s.homeMinutes[i] || 0; a += s.awayMinutes[i] || 0; }
      out.push({ label: start < 40 ? `Ç${start / 10 + 1}` : `U${(start - 40) / 5 + 1}`, h, a, from: start + 1, to: start + len });
      start += len;
    }
    return out;
  }

  function renderScore() {
    const s = score;
    if (!s) return;
    $('sbLeague').textContent = s.league || '—';
    $('sbHome').textContent = s.homeName || 'Ev sahibi';
    $('sbAway').textContent = s.awayName || 'Deplasman';
    $('sbHomeScore').textContent = s.homeScore ?? 0;
    $('sbAwayScore').textContent = s.awayScore ?? 0;
    $('sbClock').textContent = s.minute ? `${s.minute}'` : '—';
    $('sbPeriod').textContent = periodLabel(s.period);
    const box = $('sbQuarters');
    box.replaceChildren();
    for (const q of quarterSums(s)) {
      if (q.from > s.lastAbsoluteMinute) break;
      const d = el('div', 'q' + (s.lastAbsoluteMinute >= q.from && s.lastAbsoluteMinute <= q.to ? ' cur' : ''));
      d.append(el('div', 'k', q.label), el('div', 'v', `${q.h}–${q.a}`));
      box.append(d);
    }
  }

  // ── tahmin kartı ────────────────────────────────────────────────────────
  function renderPrediction() {
    const note = $('heroNote');
    note.hidden = true;
    note.className = 'hero-note';
    const chip = $('phaseChip');

    if (!pred || !pred.available) {
      chip.textContent = 'Tahmin yok';
      chip.dataset.kind = '';
      $('heroValue').textContent = '—';
      $('heroRange').textContent = '';
      $('heroLabel').textContent = 'MS toplam tahmini';
      ['statSd', 'statOt', 'statLive'].forEach((id) => { $(id).textContent = '—'; });
      $('lockProgress').hidden = true;
      $('chartCard').hidden = true;
      note.hidden = false;
      note.classList.add('warn');
      note.textContent = pred && pred.unsupported
        ? `${pred.reason} Bu maçın ligi: ${pred.league || 'bilinmiyor'}. Skor takibi devam ediyor.`
        : (pred && pred.reason) || 'Model yüklenemedi.';
      return;
    }
    $('chartCard').hidden = false;
    $('lockProgress').hidden = false;

    const { now, lock, lockRule, final } = pred;
    const rule = lockRule || { from: 21, to: 30, sd_target: 9.5 };
    const main = lock || now;
    $('heroMinute').textContent = now ? `${now.t}. dakika sonu · ${now.S} sayı` : '';

    if (!now && !lock) {
      chip.textContent = 'Veri bekleniyor';
      chip.dataset.kind = '';
      $('heroValue').textContent = '—';
      $('heroRange').textContent = 'İlk dakika tamamlanınca tahmin başlar';
    } else {
      $('heroValue').textContent = fmt(main.mean, 1);
      $('heroRange').textContent = `%80 aralık ${fmt(main.lo80, 0)} – ${fmt(main.hi80, 0)}  (±${fmt(Z80 * main.sd, 1)})`;
      if (final != null) {
        chip.textContent = 'Maç bitti'; chip.dataset.kind = 'final';
        $('heroLabel').textContent = lock ? `Kilitli tahmin (${lock.t}. dk)` : 'Son tahmin';
        note.hidden = false;
        const inside = main.lo80 <= final && final <= main.hi80;
        const err = pred.lockError;
        const errText = lock && err != null
          ? (err === 0 ? 'Kilitli tahmin tam isabet' : `Kilitli tahmin ${fmt(Math.abs(err), 1)} sayı ${err < 0 ? 'fazla' : 'eksik'}`)
          : 'Kilit oluşmadı';
        note.textContent = `Gerçek MS toplamı ${final}. ${errText}${inside ? ' — %80 aralığın içinde.' : ' — %80 aralığın dışında.'}`;
      } else if (lock) {
        chip.textContent = `Kilitlendi · ${lock.t}. dk`; chip.dataset.kind = 'locked';
        $('heroLabel').textContent = 'Kilitli MS tahmini';
      } else if (now.t >= rule.from) {
        chip.textContent = 'Kilit penceresi'; chip.dataset.kind = 'window';
        $('heroLabel').textContent = 'Canlı MS tahmini';
      } else {
        chip.textContent = 'Ön tahmin'; chip.dataset.kind = '';
        $('heroLabel').textContent = 'Canlı MS tahmini (erken — güven düşük)';
      }
    }

    $('statSd').textContent = main ? `±${fmt(Z80 * main.sd, 1)}` : '—';
    $('statOt').textContent = now ? pct(now.pOT) : (lock ? pct(lock.pOT) : '—');
    $('statLive').textContent = now ? fmt(now.mean, 1) : '—';

    // kilit ilerlemesi
    const lp = $('lockProgress');
    const target = Z80 * rule.sd_target;
    if (lock) {
      lp.dataset.done = '1';
      $('lpFill').style.width = '100%';
      $('lpText').textContent = lock.sd <= rule.sd_target + 1e-9
        ? `Tahmin ${lock.t}. dakikada kilitlendi: belirsizlik hedefe indi (±${fmt(Z80 * lock.sd, 1)} ≤ ±${fmt(target, 1)}).`
        : `Tahmin ${lock.t}. dakikada kilitlendi: kilit penceresinin sonu (belirsizlik ±${fmt(Z80 * lock.sd, 1)}).`;
    } else {
      lp.dataset.done = '0';
      if (!now || now.t < rule.from) {
        const t = now ? now.t : 0;
        $('lpFill').style.width = `${Math.min(100, (t / rule.from) * 100)}%`;
        $('lpText').textContent = `Kilit penceresi ${rule.from}–${rule.to}. dakika · şu an ${t}. dakika`;
      } else {
        $('lpFill').style.width = `${Math.min(100, (rule.sd_target / now.sd) * 100)}%`;
        $('lpText').textContent = `Belirsizlik ±${fmt(Z80 * now.sd, 1)} → kilit için hedef ±${fmt(target, 1)} (en geç ${rule.to}. dk)`;
      }
    }

    if (pred.overtime && final == null) {
      note.hidden = false;
      note.textContent = 'Uzatma oynanıyor. Model normal süre içinde tahmin yapar; uzatma ihtimali tahmine zaten dahildi.';
    }
    renderBand();
  }

  function renderBand() {
    if (!pred || !pred.available) return;
    const main = pred.lock || pred.now;
    if (!main) return;
    const lo = main.mean - 32, hi = main.mean + 32;
    const pos = (x) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100))}%`;
    const fill = $('bandFill');
    fill.style.left = pos(main.lo80);
    fill.style.width = `calc(${pos(main.hi80)} - ${pos(main.lo80)})`;
    $('bandMark').style.left = pos(main.mean);
    $('bandLo').textContent = fmt(lo, 0);
    $('bandHi').textContent = fmt(hi, 0);
    const L = parseFloat(ui.line.value);
    const line = $('bandLine');
    line.hidden = !isFinite(L);
    if (isFinite(L)) line.style.left = pos(L);
  }

  // ── barem ───────────────────────────────────────────────────────────────
  function currentMix() {
    if (!pred || !pred.available) return null;
    if (basis === 'lock' && pred.lock) return pred.lock.mix;
    return pred.now ? pred.now.mix : (pred.lock ? pred.lock.mix : null);
  }

  function renderLine() {
    const v = $('verdict');
    const L = parseFloat(ui.line.value);
    const thr = parseFloat(ui.thr.value);
    const setV = (kind, main, sub) => { v.dataset.kind = kind; $('verdictMain').textContent = main; $('verdictSub').textContent = sub; };
    const mix = currentMix();
    const p = mix && isFinite(L) ? probOver(mix, L) : null;

    $('pOver').textContent = pct(p);
    $('pUnder').textContent = p == null ? '—' : pct(1 - p);
    $('ouOver').style.width = p == null ? '50%' : `${p * 100}%`;

    if (!pred || !pred.available) return setV('none', 'Tahmin yok', 'Bu maç için model çalışmıyor.');
    if (!isFinite(L)) return setV('none', 'Barem girin', 'Olasılık, uzatma ihtimalini de içeren kalibre edilmiş modelden gelir.');
    if (!mix) return setV('wait', 'Veri bekleniyor', 'İlk dakika tamamlanınca olasılık hesaplanır.');

    const ref = basis === 'lock' && pred.lock ? pred.lock : pred.now;
    const diff = ref ? ref.mean - L : null;
    const side = p >= 0.5 ? 'ÜST' : 'ALT';
    const conf = Math.max(p, 1 - p);
    const detail = `Tahmin ${fmt(ref && ref.mean)} · barem ${L} · fark ${diff > 0 ? '+' : ''}${fmt(diff)}`;

    if (pred.final != null) {
      const actual = pred.final > L ? 'ÜST' : 'ALT';
      const ok = side === actual;
      return setV(conf >= thr ? (ok ? (side === 'ÜST' ? 'over' : 'under') : 'pass') : 'wait',
        `Sonuç: ${actual} (${pred.final})`,
        `Model ${side} %${Math.round(conf * 100)} diyordu — ${conf >= thr ? (ok ? 'karar doğru çıktı.' : 'karar tutmadı.') : 'eşiğin altındaydı, karar yoktu.'}`);
    }
    if (basis === 'lock' && !pred.lock) {
      return setV('wait', `Kilit bekleniyor · şimdilik ${side} %${Math.round(conf * 100)}`,
        `Karar kilitli tahminle verilir (${(pred.lockRule || {}).from || 21}–${(pred.lockRule || {}).to || 30}. dk). ${detail}`);
    }
    if (conf >= thr) {
      return setV(side === 'ÜST' ? 'over' : 'under', `${side} · güven %${Math.round(conf * 100)}`, detail);
    }
    return setV('pass', `PAS · güven %${Math.round(conf * 100)}`,
      `Eşik %${Math.round(thr * 100)}. Barem tahmine çok yakın; ${detail.toLowerCase()}`);
  }

  // ── grafik ──────────────────────────────────────────────────────────────
  function renderChart() {
    if (!pred || !pred.available || !window.Chart) return;
    const hist = pred.history || [];
    const L = parseFloat(ui.line.value);
    const pts = (k) => hist.map((h) => ({ x: h.t, y: h[k] }));
    const data = {
      datasets: [
        { label: 'alt', data: pts('lo80'), borderWidth: 0, pointRadius: 0, fill: false },
        { label: '%80 aralık', data: pts('hi80'), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(245,158,11,0.18)' },
        { label: 'MS tahmini', data: pts('mean'), borderColor: '#f59e0b', borderWidth: 2.5, pointRadius: 0, tension: 0.2 },
        { label: 'Barem', data: isFinite(L) ? [{ x: 1, y: L }, { x: 39, y: L }] : [], borderColor: '#60a5fa', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 },
        { label: 'Kilit', type: 'scatter', data: pred.lock ? [{ x: pred.lock.t, y: pred.lock.mean }] : [], backgroundColor: '#22c55e', pointRadius: 7, pointHoverRadius: 8 },
        { label: 'Gerçek MS', data: pred.final != null ? [{ x: 1, y: pred.final }, { x: 39, y: pred.final }] : [], borderColor: '#f4f5f7', borderWidth: 1.5, pointRadius: 0 },
      ],
    };
    if (chart) {
      chart.data = data;
      chart.update('none');
      return;
    }
    const grid = 'rgba(255,255,255,0.05)';
    chart = new Chart($('predChart'), {
      type: 'line',
      data,
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', min: 1, max: 39, ticks: { color: '#6c7280', stepSize: 5 }, grid: { color: grid }, title: { display: true, text: 'Dakika', color: '#6c7280' } },
          y: { ticks: { color: '#6c7280' }, grid: { color: grid }, title: { display: true, text: 'MS toplam', color: '#6c7280' } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(18,20,26,0.96)', borderColor: '#2f333d', borderWidth: 1,
            filter: (i) => i.dataset.label !== 'alt',
            callbacks: { title: (items) => `${items[0].parsed.x}. dakika`, label: (i) => `${i.dataset.label}: ${fmt(i.parsed.y)}` },
          },
        },
      },
    });
  }

  // ── dakika tablosu ──────────────────────────────────────────────────────
  function renderGrid() {
    if (!score) return;
    const s = score;
    const box = $('minuteGrid');
    box.replaceChildren();
    const head = el('div', 'mg-row mg-head');
    head.append(el('div', 'mg-lbl', ''));
    for (let i = 1; i <= 10; i++) head.append(el('div', 'mg-cell', `${i}'`));
    head.append(el('div', 'mg-sum mg-lbl', 'Top.'));
    box.append(head);
    const lockT = pred && pred.lock ? pred.lock.t : null;
    for (const q of quarterSums(s)) {
      const row = el('div', 'mg-row' + (q.from > 40 ? ' ot' : ''));
      row.append(el('div', 'mg-lbl', q.label));
      for (let m = q.from; m <= q.to; m++) {
        const v = (s.homeMinutes[m - 1] || 0) + (s.awayMinutes[m - 1] || 0);
        const played = m <= s.lastAbsoluteMinute;
        const c = el('div', 'mg-cell' + (played ? ' has' : '') + (m === s.lastAbsoluteMinute ? ' cur' : '') + (m === lockT ? ' lock' : ''), played ? String(v) : '');
        c.title = played ? `${m}. dk: ${s.homeMinutes[m - 1] || 0}–${s.awayMinutes[m - 1] || 0}` : `${m}. dk`;
        if (played && v) c.style.background = `rgba(245,158,11,${Math.min(0.45, v * 0.05)})`;
        row.append(c);
      }
      if (q.to - q.from + 1 === 5) for (let i = 0; i < 5; i++) row.append(el('div', 'mg-cell blank'));
      row.append(el('div', 'mg-sum', q.from <= s.lastAbsoluteMinute ? String(q.h + q.a) : ''));
      box.append(row);
    }
  }

  // ── model kartı ─────────────────────────────────────────────────────────
  function renderModel() {
    const body = $('modelBody');
    body.replaceChildren();
    const row = (k, v, cls) => {
      const r = el('div', 'row');
      const b = el('b', cls || '', v);
      r.append(el('span', '', k), b);
      body.append(r);
    };
    if (!model || !model.available) { body.append(el('div', '', 'Model yüklenemedi.')); return; }
    row('Model', 'Empirical Bayes + uzatma');
    row('Eğitim verisi', `${model.nMatches} maç`);
    row('Ligler', (model.leagues || []).map((l) => (l === 'euroleague' ? 'EuroLeague' : l === 'eurocup' ? 'EuroCup' : l)).join(' · '));
    const v = model.validation || {};
    const t = pred && pred.lock ? pred.lock.t : (pred && pred.now ? pred.now.t : 28);
    const vt = v[t] || v[String(t)];
    if (vt) {
      row(`${t}. dk ortalama hata`, `±${fmt(vt.MAE, 1)}`);
      row(`${t}. dk %80 aralık isabeti`, pct(vt.cov80));
      row(`${t}. dk ±5 içinde`, pct(vt.within5));
    }
    if (pred && pred.available && pred.context) {
      const c = pred.context;
      row('Ev sahibi eşleşmesi', c.home || 'bulunamadı', c.home ? 'team-ok' : 'team-miss');
      row('Deplasman eşleşmesi', c.away || 'bulunamadı', c.away ? 'team-ok' : 'team-miss');
      if (c.teamDev != null) row('Takım eğilimi', `${c.teamDev > 0 ? '+' : ''}${fmt(c.teamDev, 1)} sayı`);
    }
  }

  function renderIntroFacts() {
    const box = ui.facts;
    box.replaceChildren();
    if (!model || !model.available) {
      box.append(el('div', 'fact', 'Model dosyası bulunamadı — tahminler kapalı.'));
      return;
    }
    const v = model.validation || {};
    const v28 = v[28] || v['28'] || {};
    const facts = [
      ['Eğitim', `${model.nMatches} maç`],
      ['28. dk ortalama hata', `±${fmt(v28.MAE, 1)}`],
      ['%80 aralık isabeti', pct(v28.cov80)],
      ['Ligler', 'EuroLeague · EuroCup'],
    ];
    for (const [k, val] of facts) {
      const f = el('div', 'fact');
      f.append(el('div', 'k', k), el('div', 'v mono', val));
      box.append(f);
    }
  }

  // ── istatistik ──────────────────────────────────────────────────────────
  function renderStats() {
    const card = $('statsCard');
    const sections = score && score.stats;
    const rows = [];
    (sections || []).forEach((sec) => (sec.rows || []).forEach((r) => rows.push(r)));
    card.hidden = !rows.length || view !== 'predict' || !matchShown;
    $('gridCard').classList.toggle('wide', !rows.length);
    if (!rows.length) return;
    const body = $('statsBody');
    body.replaceChildren();
    for (const r of rows.slice(0, 14)) {
      const d = el('div', 'stat-row');
      d.append(el('div', 'h', r.home), el('div', 'n', r.name), el('div', 'a', r.away));
      body.append(d);
    }
  }

  // ── Hakkında ────────────────────────────────────────────────────────────
  const aboutDlg = $('aboutDlg');
  function fact(box, k, v) {
    const d = el('div', 'about-fact');
    d.append(el('div', 'k', k), el('div', 'v', v));
    box.append(d);
  }
  async function openAbout() {
    try {
      const a = await (await fetch('/api/about')).json();
      $('aboutVersion').textContent = `Sürüm ${a.version || '—'}${a.commit ? ' · ' + a.commit : ''} · Node.js ${a.node}`;
      const m = a.model || {};
      const v28 = (m.validation || {})[28] || (m.validation || {})['28'] || {};
      const mb = $('aboutModel'); mb.replaceChildren();
      if (m.available) {
        fact(mb, 'Yöntem', 'Empirical Bayes tempo modeli + uzatma karışımı');
        fact(mb, 'Eğitim verisi', `${m.nMatches} maç (EuroLeague, EuroCup 2021–2026)`);
        fact(mb, '28. dk ortalama hata', `±${fmt(v28.MAE, 1)} sayı`);
        fact(mb, '%80 aralık isabeti', pct(v28.cov80));
        fact(mb, 'Kilit kuralı', `${m.lockRule.from}–${m.lockRule.to}. dk, belirsizlik ±${fmt(Z80 * m.lockRule.sd_target, 1)} altına inince`);
        fact(mb, 'Son eğitim', (m.trainedUntil || '').slice(0, 10) || '—');
      } else {
        fact(mb, 'Model', 'yüklenemedi — tahminler kapalı');
      }
      const ib = $('aboutInstall'); ib.replaceChildren();
      fact(ib, 'Güncelleme', 'Masaüstü simgesiyle her açılışta GitHub\'dan otomatik');
      fact(ib, 'Aynı anda maç', `en fazla ${a.maxMatches}`);
      fact(ib, 'Kaydedilen maç', a.recording ? `${a.recorded} maç bu bilgisayarda` : 'kayıt kapalı');
      fact(ib, 'Veri klasörü', a.dataDir);
      fact(ib, 'Kaynak kod', a.repo.replace('https://', ''));
    } catch { /* çevrimdışı: statik metin yeterli */ }
    if (typeof aboutDlg.showModal === 'function') aboutDlg.showModal(); else aboutDlg.setAttribute('open', '');
  }
  $('aboutBtn').addEventListener('click', openAbout);
  $('aboutClose').addEventListener('click', () => aboutDlg.close());
  aboutDlg.addEventListener('click', (e) => { if (e.target === aboutDlg) aboutDlg.close(); });

  // ── açılış ──────────────────────────────────────────────────────────────
  fetch('/api/model').then((r) => r.json()).then((m) => {
    model = m;
    renderIntroFacts();
    renderModel();
  }).catch(() => { model = null; renderIntroFacts(); });
})();
