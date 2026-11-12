const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { isAllowedMatchUrl } = require('./parse');
const { MatchManager } = require('./matchManager');
const { loadPredictor } = require('./liveForecast');
const { shared: browserPool } = require('./browserPool');
const { openApp } = require('./openApp');

// DEMO_GAME=<id|random>: Flashscore yerine veri setindeki bitmiş bir maçı yeniden oynatır.
const { startWatcher } = process.env.DEMO_GAME ? require('./demo') : require('./scraper');

// ML eğitim verisi: izlenen her maç buraya kaydedilir. RECORD_MATCHES=0 ile kapatılabilir.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data/matches');
const RECORD_MATCHES = process.env.RECORD_MATCHES !== '0';
// İzlenen maç listesi: sunucu yeniden başlarsa maçlar kaldığı yerden devam eder.
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(__dirname, '../data/sessions.json');
const MAX_MATCHES = Number(process.env.MAX_MATCHES || 8);
const PORT = process.env.PORT || 3010;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const predictor = loadPredictor();
if (!predictor) console.warn('UYARI: models/eb_plus.json yüklenemedi — tahminler kapalı.');

const manager = new MatchManager({
  startWatcher,
  emit: (event, payload) => io.emit(event, payload),
  predictor,
  dataDir: RECORD_MATCHES ? DATA_DIR : null,
  sessionsFile: process.env.DEMO_GAME ? null : SESSIONS_FILE,
  maxMatches: MAX_MATCHES,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
// Tahmin matematiği tarayıcıda da çalışır (barem yazılırken Üst/Alt olasılığı anında hesaplanır).
app.get('/lib/predictor.js', (req, res) => res.sendFile(path.join(__dirname, 'predictor.js')));

const modelInfo = () => {
  if (!predictor) return { available: false };
  const m = predictor.m;
  return {
    available: true, model: m.model, nMatches: m.n_matches, trainedUntil: m.trained_until,
    leagues: m.leagues_trained, lockRule: m.lock_rule, validation: m.validation,
  };
};
app.get('/api/model', (req, res) => res.json(modelInfo()));

// "Hakkında" penceresi: sürüm, kurulum ve veri bilgisi.
app.get('/api/about', (req, res) => {
  const root = path.join(__dirname, '..');
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8').trim(); } catch { return null; } };
  let recorded = 0;
  try { recorded = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).length; } catch { /* yok */ }
  const pkg = JSON.parse(read('package.json') || '{}');
  res.json({
    version: pkg.version || null,
    commit: (read('.version') || '').slice(0, 7) || null,
    node: process.versions.node,
    dataDir: DATA_DIR,
    recorded,
    recording: RECORD_MATCHES,
    maxMatches: MAX_MATCHES,
    repo: 'https://github.com/aral-by/basketscrape',
    model: modelInfo(),
  });
});

app.get('/api/matches', (req, res) => res.json({ matches: manager.list(), maxMatches: MAX_MATCHES }));

app.post('/api/matches', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'URL gerekli' });
  if (!isAllowedMatchUrl(url)) {
    return res.status(400).json({ error: 'Yalnızca Flashscore maç adresleri kabul edilir.' });
  }
  try {
    const { session, existed } = manager.add(url);
    res.status(existed ? 200 : 201).json({ id: session.id, existed });
  } catch (e) {
    res.status(e.code === 'LIMIT' ? 409 : 500).json({ error: e.message });
  }
});

app.delete('/api/matches/:id', (req, res) => {
  res.json({ ok: manager.remove(req.params.id) });
});

// Sonradan açılan sekmeler tüm maçların son durumunu hemen alır.
io.on('connection', (socket) => {
  socket.emit('matches', { matches: manager.list(), maxMatches: MAX_MATCHES });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Sunucu çalışıyor: ${url}`);
  const restored = manager.restore();
  if (restored) console.log(`${restored} maç kaldığı yerden izlenmeye devam ediyor.`);
  if (process.env.OPEN_BROWSER === '1') openApp(url);
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Program zaten açık: ikinci kopya başlatmak yerine mevcut pencereyi aç.
  console.log(`BasketScrape zaten çalışıyor (port ${PORT}).`);
  if (process.env.OPEN_BROWSER === '1') openApp(`http://localhost:${PORT}`);
  setTimeout(() => process.exit(0), 500);
});

function shutdown() {
  manager.stopAll();
  browserPool.closeAll().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
