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
      homeScore: home, awayScore: away, stats: null });
    timer = setTimeout(tick, speed);
  };
  timer = setTimeout(tick, 300);
  return { stop() { clearTimeout(timer); } };
}

module.exports = { startWatcher, loadGame };
