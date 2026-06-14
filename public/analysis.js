const socket = io();

const homeNameEl    = document.getElementById('homeName');
const awayNameEl    = document.getElementById('awayName');
const homeTitle     = document.getElementById('homeTitle');
const awayTitle     = document.getElementById('awayTitle');
const scoreDisplay  = document.getElementById('scoreDisplay');
const matchStatusEl = document.getElementById('matchStatus');
const homeTbody     = document.getElementById('homeTbody');
const awayTbody     = document.getElementById('awayTbody');
const homeTbody40   = document.getElementById('homeTbody40');
const awayTbody40   = document.getElementById('awayTbody40');
const totalTbody    = document.getElementById('totalTbody');

// ── Side Panel ───────────────────────────────────────────────────────────────
const menuBtn       = document.getElementById('menuBtn');
const sidePanel     = document.getElementById('sidePanel');
const closePanelBtn = document.getElementById('closePanelBtn');
const panelStats    = document.getElementById('panelStats');

menuBtn.addEventListener('click', () => {
  sidePanel.classList.add('open');
  document.body.style.overflow = 'hidden';
});
closePanelBtn.addEventListener('click', () => {
  sidePanel.classList.remove('open');
  document.body.style.overflow = '';
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { sidePanel.classList.remove('open'); document.body.style.overflow = ''; }
});

let latestHomeScore = 0;
let latestAwayScore = 0;
let latestHomeName  = 'Ev Sahibi';
let latestAwayName  = 'Deplasman';

// ── Score Chart ──────────────────────────────────────────────────────────────
let chart = null;

function initChart(homeName, awayName) {
  const ctx = document.getElementById('scoreChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: homeName || 'Ev Sahibi', data: [], borderColor: '#8a6dcc', backgroundColor: 'rgba(138,109,204,0.12)', tension: 0.35, pointRadius: 4, pointHoverRadius: 6, fill: true },
        { label: awayName || 'Deplasman', data: [], borderColor: '#e05c5c', backgroundColor: 'rgba(224,92,92,0.10)',   tension: 0.35, pointRadius: 4, pointHoverRadius: 6, fill: true },
      ],
    },
    options: {
      responsive: true, animation: { duration: 250 }, interaction: { mode: 'index', intersect: false },
      scales: {
        x: { title: { display: true, text: 'Dakika', color: '#b19cd9', font: { size: 12 } }, ticks: { color: '#888', maxTicksLimit: 20 }, grid: { color: 'rgba(177,156,217,0.08)' } },
        y: { title: { display: true, text: 'Atılan Sayı', color: '#b19cd9', font: { size: 12 } }, ticks: { color: '#888', stepSize: 1 }, grid: { color: 'rgba(177,156,217,0.08)' }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: '#b19cd9', font: { size: 12 } } }, tooltip: { backgroundColor: 'rgba(30,20,50,0.92)', titleColor: '#b19cd9', bodyColor: '#e0e0e0' } },
    },
  });
}

function updateChart(homeMinutes, awayMinutes, lastAbsoluteMinute, homeName, awayName) {
  if (!chart) initChart(homeName, awayName);
  const count = Math.max(lastAbsoluteMinute, 1);
  chart.data.labels            = Array.from({ length: count }, (_, i) => i + 1);
  chart.data.datasets[0].data  = homeMinutes.slice(0, count);
  chart.data.datasets[0].label = homeName || 'Ev Sahibi';
  chart.data.datasets[1].data  = awayMinutes.slice(0, count);
  chart.data.datasets[1].label = awayName  || 'Deplasman';
  chart.update();
}

// ── Total ×40 Chart ──────────────────────────────────────────────────────────
let totalChart = null;

function initTotalChart() {
  const ctx = document.getElementById('totalChart').getContext('2d');
  totalChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{ label: 'Toplam (×40)', data: [], borderColor: '#2ecc71', backgroundColor: 'rgba(46,204,113,0.12)', tension: 0.35, pointRadius: 4, pointHoverRadius: 6, fill: true }],
    },
    options: {
      responsive: true, animation: { duration: 250 }, interaction: { mode: 'index', intersect: false },
      scales: {
        x: { title: { display: true, text: 'Dakika', color: '#2ecc71', font: { size: 12 } }, ticks: { color: '#888', maxTicksLimit: 20 }, grid: { color: 'rgba(46,204,113,0.06)' } },
        y: { title: { display: true, text: 'Toplam ×40', color: '#2ecc71', font: { size: 12 } }, ticks: { color: '#888' }, grid: { color: 'rgba(46,204,113,0.06)' }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: '#2ecc71', font: { size: 12 } } }, tooltip: { backgroundColor: 'rgba(10,30,15,0.92)', titleColor: '#2ecc71', bodyColor: '#e0e0e0' } },
    },
  });
}

function updateTotalChart(homeMinutes, awayMinutes, lastAbsoluteMinute) {
  if (!totalChart) initTotalChart();
  const count = Math.max(lastAbsoluteMinute, 1);
  totalChart.data.labels           = Array.from({ length: count }, (_, i) => i + 1);
  totalChart.data.datasets[0].data = Array.from({ length: count }, (_, i) => ((homeMinutes[i] ?? 0) + (awayMinutes[i] ?? 0)) * 40);
  totalChart.update();
}

// ── Table Rendering ──────────────────────────────────────────────────────────
function renderTbody(tbody, minutes, totalCells, lastAbsoluteMinute, multiplier = 1) {
  tbody.innerHTML = '';
  for (let period = 1; period <= 4; period++) {
    const tr = document.createElement('tr');
    const lbl = document.createElement('td');
    lbl.className = 'period-label'; lbl.textContent = period + '. Çeyrek';
    tr.appendChild(lbl);
    for (let min = 1; min <= 10; min++) tr.appendChild(makeScoreCell(minutes, (period - 1) * 10 + min, lastAbsoluteMinute, multiplier));
    tbody.appendChild(tr);
  }
  if (totalCells > 40) {
    const otCount = Math.ceil((totalCells - 40) / 5);
    for (let ot = 1; ot <= otCount; ot++) {
      const tr = document.createElement('tr');
      const lbl = document.createElement('td');
      lbl.className = 'period-label'; lbl.textContent = ot + '. Uzatma';
      tr.appendChild(lbl);
      for (let min = 1; min <= 10; min++) {
        if (min <= 5) tr.appendChild(makeScoreCell(minutes, 40 + (ot - 1) * 5 + min, lastAbsoluteMinute, multiplier));
        else { const td = document.createElement('td'); td.className = 'empty-cell'; td.textContent = '–'; tr.appendChild(td); }
      }
      tbody.appendChild(tr);
    }
  }
}

function makeScoreCell(minutes, absoluteMin, lastAbsoluteMinute, multiplier = 1) {
  const td  = document.createElement('td');
  const val = (minutes[absoluteMin - 1] ?? 0) * multiplier;
  if (absoluteMin === lastAbsoluteMinute) { td.className = 'active-cell'; if (val > 0) td.textContent = val; }
  else if (absoluteMin < lastAbsoluteMinute) { if (val > 0) { td.className = 'has-score'; td.textContent = val; } }
  return td;
}

function renderTotalTbody(tbody, homeMinutes, awayMinutes, totalCells, lastAbsoluteMinute) {
  tbody.innerHTML = '';
  for (let period = 1; period <= 4; period++) {
    const tr = document.createElement('tr');
    const lbl = document.createElement('td');
    lbl.className = 'period-label'; lbl.style.background = 'rgba(192,57,43,0.18)'; lbl.textContent = period + '. Çeyrek';
    tr.appendChild(lbl);
    for (let min = 1; min <= 10; min++) tr.appendChild(makeTotalCell(homeMinutes, awayMinutes, (period - 1) * 10 + min, lastAbsoluteMinute));
    tbody.appendChild(tr);
  }
  if (totalCells > 40) {
    const otCount = Math.ceil((totalCells - 40) / 5);
    for (let ot = 1; ot <= otCount; ot++) {
      const tr = document.createElement('tr');
      const lbl = document.createElement('td');
      lbl.className = 'period-label'; lbl.style.background = 'rgba(192,57,43,0.18)'; lbl.textContent = ot + '. Uzatma';
      tr.appendChild(lbl);
      for (let min = 1; min <= 10; min++) {
        if (min <= 5) tr.appendChild(makeTotalCell(homeMinutes, awayMinutes, 40 + (ot - 1) * 5 + min, lastAbsoluteMinute));
        else { const td = document.createElement('td'); td.className = 'total-cell empty-cell'; td.textContent = '–'; tr.appendChild(td); }
      }
      tbody.appendChild(tr);
    }
  }
}

function makeTotalCell(homeMinutes, awayMinutes, absoluteMin, lastAbsoluteMinute) {
  const td  = document.createElement('td');
  td.className = 'total-cell';
  const val = ((homeMinutes[absoluteMin - 1] ?? 0) + (awayMinutes[absoluteMin - 1] ?? 0)) * 40;
  if (absoluteMin === lastAbsoluteMinute) { td.classList.add('active-cell'); if (val > 0) td.textContent = val; }
  else if (absoluteMin < lastAbsoluteMinute) { if (val > 0) { td.classList.add('has-score'); td.textContent = val; } }
  return td;
}

// ── Stats Parsing & Metrics ──────────────────────────────────────────────────
function parseStat(s) {
  if (!s) return { made: 0, att: 0 };
  const frac = String(s).match(/(\d+)\s*\/\s*(\d+)/);
  if (frac) return { made: +frac[1], att: +frac[2] };
  const n = parseFloat(String(s).replace(',', '.').replace('%', ''));
  return { made: isNaN(n) ? 0 : n, att: 0 };
}

function flatStats(sections) {
  const map = {};
  (sections || []).forEach(({ rows }) => {
    (rows || []).forEach(({ name, home, away }) => {
      map[name.toLowerCase().trim()] = { home: parseStat(home), away: parseStat(away) };
    });
  });
  return map;
}

function findStat(flat, ...kws) {
  for (const key of Object.keys(flat)) {
    if (kws.some(kw => key.includes(kw.toLowerCase()))) return flat[key];
  }
  return { home: { made: 0, att: 0 }, away: { made: 0, att: 0 } };
}

function safe(n) { return isNaN(n) || !isFinite(n) ? 0 : n; }

function computeMetrics(sections, homeName, awayName, homeScore, awayScore) {
  const flat = flatStats(sections);
  console.log('[basketscrape] Stat isimleri:', Object.keys(flat));

  // Flashscore'da "Alan Golü" = toplam FG (2P+3P birlikte), 2P ayrı gelmez.
  // totalFg → alan golü / field goal (toplam)
  // fg2only → yalnızca "iki sayılık" gibi açık 2P stat varsa kullanılır
  const totalFg = findStat(flat, 'alan gol', 'sahadan', 'field goal');
  const fg2only = findStat(flat, 'iki say', '2 say', '2-say', 'iki sayılık');
  const fg3     = findStat(flat, 'üç say', '3 say', 'üçlük', '3-say', 'three', 'üç sayılık');
  const ft      = findStat(flat, 'serbest atış', 'free throw', 'serbest');
  const orb     = findStat(flat, 'hücum rib', 'ofansif r', 'off reb', 'hücum ribaund');
  const drb     = findStat(flat, 'savunma rib', 'defansif r', 'def reb', 'savunma ribaund');
  const tov     = findStat(flat, 'top kayb', 'turnover', 'kayıp');
  const ast     = findStat(flat, 'asist', 'assist');

  console.log('[basketscrape] Eşleşme → totalFg:', totalFg, 'fg3:', fg3, 'ft:', ft, 'orb:', orb, 'drb:', drb, 'tov:', tov);

  // FG kaynağını çöz: totalFg eşleştiyse 2P = total − 3P, yoksa fg2only + fg3 kullan
  function resolveFg(side) {
    const tot = totalFg[side];
    const two = fg2only[side];
    const thr = fg3[side];
    if (tot.att > 0 && tot.att >= thr.att) {
      // Flashscore toplam FG verdi → 2P'yi türet
      return {
        fgm: tot.made,
        fga: tot.att,
        fg2m: Math.max(0, tot.made - thr.made),
        fg2a: Math.max(0, tot.att  - thr.att),
        fg3m: thr.made,
        fg3a: thr.att,
      };
    }
    // Açık 2P + 3P verisi var
    return {
      fgm: two.made + thr.made,
      fga: two.att  + thr.att,
      fg2m: two.made,
      fg2a: two.att,
      fg3m: thr.made,
      fg3a: thr.att,
    };
  }

  const hFg = resolveFg('home');
  const aFg = resolveFg('away');

  const h = {
    ...hFg,
    ftm: ft.home.made,  fta: ft.home.att,
    orb: orb.home.made, drb: drb.home.made,
    tov: tov.home.made, ast: ast.home.made,
    pts: homeScore || 0,
  };
  const a = {
    ...aFg,
    ftm: ft.away.made,  fta: ft.away.att,
    orb: orb.away.made, drb: drb.away.made,
    tov: tov.away.made, ast: ast.away.made,
    pts: awayScore || 0,
  };

  const hFGA = h.fga || 1;
  const aFGA = a.fga || 1;

  // ── Dean Oliver Four Factors ──────────────────────────────────────────
  // 1) eFG% = (FGM + 0.5 × 3PM) / FGA
  const heFG = safe((h.fgm + 0.5 * h.fg3m) / hFGA);
  const aeFG = safe((a.fgm + 0.5 * a.fg3m) / aFGA);

  // 2) TOV% = TOV / (FGA + 0.44×FTA + TOV)   [grafik: 1−TOV%, yüksek=iyi]
  const hTOVpct = safe(h.tov / ((hFGA + 0.44 * h.fta + h.tov) || 1));
  const aTOVpct = safe(a.tov / ((aFGA + 0.44 * a.fta + a.tov) || 1));

  // 3) ORB% = ORB / (ORB + opp_DRB)
  const hORBpct = safe(h.orb / ((h.orb + a.drb) || 1));
  const aORBpct = safe(a.orb / ((a.orb + h.drb) || 1));

  // 4) FTR = FTA / FGA  (Dean Oliver orijinal)
  const hFTR = safe(h.fta / hFGA);
  const aFTR = safe(a.fta / aFGA);

  // ── True Shooting % ───────────────────────────────────────────────────
  // TS% = PTS / (2 × (FGA + 0.44 × FTA))   — eFG%'den kapsamlı, SA dahil
  const hTS = safe(h.pts / (2 * ((hFGA + 0.44 * h.fta) || 1)));
  const aTS = safe(a.pts / (2 * ((aFGA + 0.44 * a.fta) || 1)));

  // ── Possession (Oliver formülü) ───────────────────────────────────────
  // Poss = FGA − ORB + TOV + 0.44 × FTA
  const hPoss   = Math.max(1, h.fga - h.orb + h.tov + 0.44 * h.fta);
  const aPoss   = Math.max(1, a.fga - a.orb + a.tov + 0.44 * a.fta);
  const avgPoss = (hPoss + aPoss) / 2;  // simetrik baz; her iki takım için aynı payda

  // ── Ratings (100 hücum başına, avgPoss baz) ───────────────────────────
  const hOffRtg = safe(100 * h.pts / avgPoss);
  const aOffRtg = safe(100 * a.pts / avgPoss);
  const hDefRtg = aOffRtg;   // savunma puanı = rakibin hücum puanı
  const aDefRtg = hOffRtg;
  const hNetRtg = hOffRtg - hDefRtg;
  const aNetRtg = aOffRtg - aDefRtg;

  return {
    fourFactors: {
      home: [heFG, 1 - hTOVpct, hORBpct, Math.min(hFTR, 1)],
      away: [aeFG, 1 - aTOVpct, aORBpct, Math.min(aFTR, 1)],
    },
    ratings: {
      home: [hOffRtg, hDefRtg, hNetRtg],
      away: [aOffRtg, aDefRtg, aNetRtg],
    },
    shots: {
      labels: [homeName, awayName],
      made2:  [h.fg2m,                       a.fg2m],
      miss2:  [Math.max(0, h.fg2a - h.fg2m), Math.max(0, a.fg2a - a.fg2m)],
      made3:  [h.fg3m,                       a.fg3m],
      miss3:  [Math.max(0, h.fg3a - h.fg3m), Math.max(0, a.fg3a - a.fg3m)],
      madeFT: [h.ftm,                        a.ftm],
      missFT: [Math.max(0, h.fta - h.ftm),   Math.max(0, a.fta - a.ftm)],
    },
    possession: {
      labels: [homeName, awayName],
      data:   [Math.max(0.01, hPoss), Math.max(0.01, aPoss)],
    },
    meta: { hTS, aTS, hPoss, aPoss, avgPoss },
  };
}

// ── Side Panel Charts ────────────────────────────────────────────────────────
let radarChart  = null;
let rtgBarChart = null;
let shotChart   = null;
let possChart   = null;

const TT = { backgroundColor: 'rgba(20,10,40,0.93)', titleColor: '#b19cd9', bodyColor: '#e0e0e0' };

function initSideCharts(homeName, awayName) {
  radarChart = new Chart(document.getElementById('radarChart'), {
    type: 'radar',
    data: {
      labels: ['eFG%', 'TOV%\n(Ters)', 'ORB%', 'FTR'],
      datasets: [
        { label: homeName, data: [0,0,0,0], borderColor: '#8a6dcc', backgroundColor: 'rgba(138,109,204,0.22)', pointBackgroundColor: '#8a6dcc', pointRadius: 4 },
        { label: awayName, data: [0,0,0,0], borderColor: '#e05c5c', backgroundColor: 'rgba(224,92,92,0.18)',   pointBackgroundColor: '#e05c5c', pointRadius: 4 },
      ],
    },
    options: {
      responsive: true, animation: { duration: 400 },
      scales: { r: { min: 0, max: 1, ticks: { display: false, backdropColor: 'transparent' }, grid: { color: 'rgba(177,156,217,0.2)' }, angleLines: { color: 'rgba(177,156,217,0.2)' }, pointLabels: { color: '#b19cd9', font: { size: 11 } } } },
      plugins: { legend: { labels: { color: '#b19cd9', font: { size: 11 } } }, tooltip: TT },
    },
  });

  rtgBarChart = new Chart(document.getElementById('rtgBarChart'), {
    type: 'bar',
    data: {
      labels: ['OffRtg', 'DefRtg', 'NetRtg'],
      datasets: [
        { label: homeName, data: [0,0,0], backgroundColor: 'rgba(138,109,204,0.3)', borderColor: '#8a6dcc', borderWidth: 2, borderRadius: 4 },
        { label: awayName, data: [0,0,0], backgroundColor: 'rgba(224,92,92,0.25)',  borderColor: '#e05c5c', borderWidth: 2, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, animation: { duration: 400 },
      scales: {
        x: { ticks: { color: '#aaa' }, grid: { color: 'rgba(177,156,217,0.08)' } },
        y: { ticks: { color: '#aaa' }, grid: { color: 'rgba(177,156,217,0.08)' } },
      },
      plugins: { legend: { labels: { color: '#b19cd9', font: { size: 11 } } }, tooltip: TT },
    },
  });

  shotChart = new Chart(document.getElementById('shotChart'), {
    type: 'bar',
    data: {
      labels: [homeName, awayName],
      datasets: [
        { label: '2\'lik İsabet', data: [0,0], backgroundColor: 'rgba(138,109,204,0.85)', stack: 'shots' },
        { label: '2\'lik Isk.',   data: [0,0], backgroundColor: 'rgba(138,109,204,0.22)', stack: 'shots' },
        { label: '3\'lük İsabet', data: [0,0], backgroundColor: 'rgba(46,204,113,0.85)',  stack: 'shots' },
        { label: '3\'lük Isk.',   data: [0,0], backgroundColor: 'rgba(46,204,113,0.22)',  stack: 'shots' },
        { label: 'SA İsabet',     data: [0,0], backgroundColor: 'rgba(241,196,15,0.85)',  stack: 'shots' },
        { label: 'SA Isk.',       data: [0,0], backgroundColor: 'rgba(241,196,15,0.22)',  stack: 'shots' },
      ],
    },
    options: {
      responsive: true, animation: { duration: 400 },
      scales: {
        x: { stacked: true, ticks: { color: '#aaa' }, grid: { color: 'rgba(177,156,217,0.08)' } },
        y: { stacked: true, ticks: { color: '#aaa' }, grid: { color: 'rgba(177,156,217,0.08)' }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: '#b19cd9', font: { size: 10 } } }, tooltip: TT },
    },
  });

  possChart = new Chart(document.getElementById('possChart'), {
    type: 'doughnut',
    data: {
      labels: [homeName, awayName],
      datasets: [{ data: [1,1], backgroundColor: ['rgba(138,109,204,0.35)', 'rgba(224,92,92,0.30)'], borderColor: ['#8a6dcc', '#e05c5c'], borderWidth: 2, hoverOffset: 8 }],
    },
    options: {
      responsive: true, animation: { duration: 400 },
      plugins: {
        legend: { labels: { color: '#b19cd9', font: { size: 12 } } },
        tooltip: {
          ...TT,
          callbacks: {
            label(ctx) {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : '0.0';
              return ` ${ctx.label}: ${pct}%`;
            },
          },
        },
      },
    },
  });
}

function updateSideCharts(metrics, homeName, awayName) {
  if (!radarChart) initSideCharts(homeName, awayName);

  radarChart.data.datasets[0].data  = metrics.fourFactors.home;
  radarChart.data.datasets[0].label = homeName;
  radarChart.data.datasets[1].data  = metrics.fourFactors.away;
  radarChart.data.datasets[1].label = awayName;
  radarChart.update();

  rtgBarChart.data.datasets[0].data  = metrics.ratings.home;
  rtgBarChart.data.datasets[0].label = homeName;
  rtgBarChart.data.datasets[1].data  = metrics.ratings.away;
  rtgBarChart.data.datasets[1].label = awayName;
  rtgBarChart.update();

  const s = metrics.shots;
  shotChart.data.labels           = s.labels;
  shotChart.data.datasets[0].data = s.made2;
  shotChart.data.datasets[1].data = s.miss2;
  shotChart.data.datasets[2].data = s.made3;
  shotChart.data.datasets[3].data = s.miss3;
  shotChart.data.datasets[4].data = s.madeFT;
  shotChart.data.datasets[5].data = s.missFT;
  shotChart.update();

  possChart.data.labels           = metrics.possession.labels;
  possChart.data.datasets[0].data = metrics.possession.data;
  possChart.update();
}

function updatePanelStats(sections, homeName, awayName) {
  panelStats.innerHTML = '';
  if (!sections || sections.length === 0) {
    panelStats.innerHTML = '<p class="no-stats">İstatistikler bekleniyor...</p>';
    return;
  }

  const colHdr = document.createElement('div');
  colHdr.className = 'stats-col-header';
  colHdr.innerHTML = `<span class="s-col-home">${homeName}</span><span class="s-col-mid">İstatistikler</span><span class="s-col-away">${awayName}</span>`;
  panelStats.appendChild(colHdr);

  const grid = document.createElement('div');
  grid.className = 'stats-sections';

  sections.forEach(({ title, rows }) => {
    const sec = document.createElement('div');
    sec.className = 'stats-section';
    if (title) {
      const t = document.createElement('div');
      t.className = 'stats-section-title'; t.textContent = title;
      sec.appendChild(t);
    }
    const table = document.createElement('table');
    table.className = 'stats-table';
    rows.forEach(({ name, home, away }) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="s-home">${home}</td><td class="s-name">${name}</td><td class="s-away">${away}</td>`;
      table.appendChild(tr);
    });
    sec.appendChild(table);
    grid.appendChild(sec);
  });

  panelStats.appendChild(grid);
}

function updateMetaStats(meta, homeName, awayName) {
  const fmt = (v) => (v * 100).toFixed(1) + '%';
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('metaHomeTS',   fmt(meta.hTS));
  setEl('metaAwayTS',   fmt(meta.aTS));
  setEl('metaHomePoss', Math.round(meta.hPoss));
  setEl('metaAwayPoss', Math.round(meta.aPoss));
  setEl('metaAvgPoss',  Math.round(meta.avgPoss));
}

function updateSidePanel(sections, homeName, awayName, homeScore, awayScore) {
  updatePanelStats(sections, homeName, awayName);
  const metrics = computeMetrics(sections, homeName, awayName, homeScore, awayScore);
  updateSideCharts(metrics, homeName, awayName);
  updateMetaStats(metrics.meta, homeName, awayName);
}

// ── Socket Handlers ──────────────────────────────────────────────────────────
socket.on('scoreUpdate', (state) => {
  const { homeMinutes, awayMinutes, totalCells, lastAbsoluteMinute,
          homeName, awayName, homeScore, awayScore, periodText, minute, stats } = state;

  if (homeName) {
    homeNameEl.textContent  = homeName;
    homeTitle.textContent   = homeName;
    document.getElementById('homeTitle40').textContent = homeName + ' (×40)';
    latestHomeName = homeName;
  }
  if (awayName) {
    awayNameEl.textContent  = awayName;
    awayTitle.textContent   = awayName;
    document.getElementById('awayTitle40').textContent = awayName + ' (×40)';
    latestAwayName = awayName;
  }
  if (homeScore !== undefined && awayScore !== undefined) {
    scoreDisplay.textContent = `${homeScore} : ${awayScore}`;
    latestHomeScore = homeScore;
    latestAwayScore = awayScore;
  }
  if (periodText && minute !== undefined) {
    matchStatusEl.textContent = `${periodText}  ${minute}. dakika`;
    matchStatusEl.className = 'match-status';
  }

  renderTbody(homeTbody,   homeMinutes, totalCells, lastAbsoluteMinute);
  renderTbody(awayTbody,   awayMinutes, totalCells, lastAbsoluteMinute);
  renderTbody(homeTbody40, homeMinutes, totalCells, lastAbsoluteMinute, 40);
  renderTbody(awayTbody40, awayMinutes, totalCells, lastAbsoluteMinute, 40);
  renderTotalTbody(totalTbody, homeMinutes, awayMinutes, totalCells, lastAbsoluteMinute);
  updateChart(homeMinutes, awayMinutes, lastAbsoluteMinute, homeName, awayName);
  updateTotalChart(homeMinutes, awayMinutes, lastAbsoluteMinute);
  if (stats) updateSidePanel(stats, latestHomeName, latestAwayName, latestHomeScore, latestAwayScore);
});

socket.on('matchStatus', ({ status, homeName, awayName, message }) => {
  if (homeName) { homeNameEl.textContent = homeName; homeTitle.textContent = homeName; latestHomeName = homeName; }
  if (awayName) { awayNameEl.textContent = awayName; awayTitle.textContent = awayName; latestAwayName = awayName; }

  const labels = {
    not_started: 'Maç henüz başlamadı, bekleniyor...',
    running:     'Maç devam ediyor',
    finished:    'Maç Sona Erdi',
    error:       'Hata: ' + (message || ''),
    stopped:     'Durduruldu',
  };
  matchStatusEl.textContent = labels[status] || message || status;
  matchStatusEl.className   = 'match-status' + (status === 'finished' ? ' finished' : '');
});

socket.on('matchEnd', (result) => {
  matchStatusEl.textContent = 'Bu maç bitmiş';
  matchStatusEl.className = 'match-status finished';
  if (result.state) {
    const { homeMinutes, awayMinutes, totalCells, lastAbsoluteMinute, homeName, awayName } = result.state;
    if (homeName) latestHomeName = homeName;
    if (awayName) latestAwayName = awayName;
    renderTbody(homeTbody,   homeMinutes, totalCells, lastAbsoluteMinute);
    renderTbody(awayTbody,   awayMinutes, totalCells, lastAbsoluteMinute);
    renderTbody(homeTbody40, homeMinutes, totalCells, lastAbsoluteMinute, 40);
    renderTbody(awayTbody40, awayMinutes, totalCells, lastAbsoluteMinute, 40);
    renderTotalTbody(totalTbody, homeMinutes, awayMinutes, totalCells, lastAbsoluteMinute);
    updateChart(homeMinutes, awayMinutes, lastAbsoluteMinute, homeName, awayName);
    updateTotalChart(homeMinutes, awayMinutes, lastAbsoluteMinute);
    if (result.state.stats) updateSidePanel(result.state.stats, latestHomeName, latestAwayName, latestHomeScore, latestAwayScore);
  }
});
