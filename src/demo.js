// Demo watcher: replays a finished game from ml/datasets/euroleague minute by minute with the
// same interface as scraper.startWatcher. Enable with DEMO_GAME=<id> (e.g. E2025-120) or
// DEMO_GAME=random; DEMO_SPEED = milliseconds per game minute (default 1500).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ScoreBoard = require('./gameState');

const DATA = path.join(__dirname, '../ml/datasets/euroleague');

function loadGame(id) {
  const files = fs.readdirSync(DATA).filter((f) => f.endsWith('.jsonl.gz')).sort();
  const wanted = id && id !== 'random' ? files.filter((f) => id.startsWith(f.replace('.jsonl.gz', ''))) : files;
  const games = [];
  for (const f of wanted) {
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString('utf8').split('\n');
    for (const l of lines) if (l.trim()) games.push(JSON.parse(l));
  }
  if (!games.length) throw new Error(`demo: no game for ${id}`);
  return id && id !== 'random' ? games.find((g) => g.id === id) : games[Math.floor(Math.random() * games.length)];
}

// Demo only: plausible team statistics derived from the score, clearly labelled as not real.
function demoStats(home, away, minute, seed) {
  let x = seed;
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const side = (pts) => {
    const ftm = Math.round(pts * (0.14 + rnd() * 0.06));
    const fg3m = Math.round((pts - ftm) * (0.3 + rnd() * 0.12) / 3);
    const fg2m = Math.max(0, Math.round((pts - ftm - fg3m * 3) / 2));
    const f = minute / 40;
    return {
      fg: [fg2m + fg3m, Math.round(fg2m / (0.5 + rnd() * 0.1) + fg3m / (0.33 + rnd() * 0.08))],
      fg2: [fg2m, Math.round(fg2m / (0.5 + rnd() * 0.1))], fg3: [fg3m, Math.round(fg3m / (0.33 + rnd() * 0.08))],
      ft: [ftm, Math.round(ftm / (0.72 + rnd() * 0.12))],
      orb: Math.round((7 + rnd() * 6) * f), drb: Math.round((20 + rnd() * 8) * f), ast: Math.round((14 + rnd() * 8) * f),
      tov: Math.round((10 + rnd() * 6) * f), stl: Math.round((5 + rnd() * 4) * f), blk: Math.round((2 + rnd() * 3) * f),
      pf: Math.round((16 + rnd() * 8) * f),
    };
  };
  const H = side(home), A = side(away);
  const fr = (p) => `${p[0]}/${p[1]}`;
  const row = (name, h, a) => ({ name, home: String(h), away: String(a) });
  return [{ title: 'DEMO istatistikleri (gerçek değil)', rows: [
    row('Alan Golü', fr(H.fg), fr(A.fg)), row('İki Sayılık', fr(H.fg2), fr(A.fg2)), row('Üç Sayılık', fr(H.fg3), fr(A.fg3)),
    row('Serbest Atış', fr(H.ft), fr(A.ft)), row('Hücum Ribaundu', H.orb, A.orb), row('Savunma Ribaundu', H.drb, A.drb),
    row('Toplam Ribaund', H.orb + H.drb, A.orb + A.drb), row('Asist', H.ast, A.ast), row('Top Kaybı', H.tov, A.tov),
    row('Top Çalma', H.stl, A.stl), row('Blok', H.blk, A.blk), row('Fauller', H.pf, A.pf),
  ] }];
}

function periodOf(m) {
  if (m <= 40) return { period: Math.ceil(m / 10), minute: ((m - 1) % 10) + 1 };
  return { period: 5 + Math.floor((m - 41) / 5), minute: ((m - 41) % 5) + 1 };
}

function startWatcher(url, onUpdate, onEnd, onLog, onStatus, opts = {}) {
  const game = loadGame(opts.game || process.env.DEMO_GAME);
  const speed = Number(opts.speed || process.env.DEMO_SPEED || 1500);
  const league = /eurocup/i.test(game.league) ? 'EUROPE: EuroCup' : 'EUROPE: Euroleague';
  const { homeName, awayName } = game;
  const board = new ScoreBoard();
  board.update(1, 1, 0, 0);   // tip-off: like the live page, the first reading is 0-0
  const n = game.cumulative.home.length;
  let m = 0;
  let timer = null;
  // the real watcher reports asynchronously; the server only assigns `watcher` after return
  setImmediate(() => {
    onLog(`DEMO: ${game.id} ${homeName} – ${awayName} yeniden oynatılıyor (${speed} ms/dk)`);
    onStatus({ status: 'running', homeName, awayName });
  });

  const tick = () => {
    m += 1;
    if (m > n) {
      const final = { home: game.final.home, away: game.final.away };
      onStatus({ status: 'finished', homeName, awayName, message: 'Maç sona erdi.' });
      onEnd({ reason: 'finished', final, state: { ...board.getState(), homeName, awayName, league } });
      return;
    }
    const { period, minute } = periodOf(m);
    const home = game.cumulative.home[m - 1];
    const away = game.cumulative.away[m - 1];
    board.update(period, minute, home, away);
    onUpdate({ ...board.getState(), homeName, awayName, league, period, periodText: '', minute,
      homeScore: home, awayScore: away, stats: demoStats(home, away, m, game.id.length * 7 + 11),
      // resmi EuroLeague verisi (oyuncular, faul, olaylar) bu dakikaya kadar gösterilir
      officialGame: { season: game.id.split('-')[0], gameCode: Number(game.id.split('-')[1]), swapped: false } });
    timer = setTimeout(tick, speed);
  };
  timer = setTimeout(tick, 300);
  return { stop() { clearTimeout(timer); } };
}

module.exports = { startWatcher, loadGame };
