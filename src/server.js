const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
// DEMO_GAME=<id|random>: Flashscore yerine veri setindeki bitmiş bir maçı yeniden oynatır.
const { startWatcher } = process.env.DEMO_GAME ? require('./demo') : require('./scraper');
const { isAllowedMatchUrl } = require('./parse');
const { MatchRecorder } = require('./recorder');
const { LiveForecast, loadPredictor } = require('./liveForecast');

// ML eğitim verisi: izlenen her maç buraya kaydedilir. RECORD_MATCHES=0 ile kapatılabilir.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data/matches');
const RECORD_MATCHES = process.env.RECORD_MATCHES !== '0';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const predictor = loadPredictor();
if (!predictor) console.warn('UYARI: models/eb_plus.json yüklenemedi — tahminler kapalı.');
const forecast = new LiveForecast(predictor);

app.use(express.json());
// Eski panel adresi yeni panele yönlenir.
app.get('/analysis.html', (req, res) => res.redirect(301, '/'));
app.use(express.static(path.join(__dirname, '../public')));
// Tahmin matematiği tarayıcıda da çalışır (barem yazılırken Üst/Alt olasılığı anında hesaplanır).
app.get('/lib/predictor.js', (req, res) => res.sendFile(path.join(__dirname, 'predictor.js')));
app.get('/api/model', (req, res) => res.json(forecast.info()));

let activeWatcher  = null;
let activeRecorder = null;

// Sonradan bağlanan sekmeler (örn. analiz sayfası) boş ekran görmesin diye son durum saklanır.
let lastStatus = null;
let lastUpdate = null;
let lastEnd    = null;
let lastPrediction = null;

function clearSnapshot() {
  lastStatus = null;
  lastUpdate = null;
  lastEnd    = null;
  lastPrediction = null;
  forecast.reset();
}

io.on('connection', (socket) => {
  if (lastStatus) socket.emit('matchStatus', lastStatus);
  if (lastUpdate) socket.emit('scoreUpdate', lastUpdate);
  if (lastEnd)    socket.emit('matchEnd', lastEnd);
  if (lastPrediction) socket.emit('prediction', lastPrediction);
});

function stopActive() {
  if (activeWatcher) {
    activeWatcher.stop();
    activeWatcher = null;
  }
  if (activeRecorder) {
    activeRecorder.stop();
    activeRecorder = null;
  }
}

app.post('/start', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'URL gerekli' });
  if (!isAllowedMatchUrl(url)) {
    return res.status(400).json({ error: 'Yalnızca Flashscore maç adresleri kabul edilir.' });
  }

  stopActive();
  clearSnapshot();
  io.emit('log', 'Scraper başlatılıyor...');

  const recorder = RECORD_MATCHES ? new MatchRecorder(url, { dir: DATA_DIR }) : null;

  // startWatcher hemen döner; maçın başlamasını arka planda bekler.
  // Callback'ler yalnızca HÂLÂ aktif olan watcher içinse yayın yapar — eski bir
  // watcher'ın geç gelen olayları yenisinin durumunu ezmesin.
  const watcher = startWatcher(
    url,
    (state) => {
      if (activeWatcher !== watcher) return;
      if (recorder) recorder.update(state);
      lastUpdate = state;
      io.emit('scoreUpdate', state);
      lastPrediction = forecast.update(state);
      io.emit('prediction', lastPrediction);
    },
    (result) => {
      if (activeWatcher !== watcher) return;
      if (recorder) recorder.finish(result);
      lastEnd = result;
      const done = forecast.finish(result);
      if (done) {
        lastPrediction = done;
        io.emit('prediction', done);
      }
      activeWatcher = null;
      activeRecorder = null;
      io.emit('matchEnd', result);
    },
    (msg) => {
      if (activeWatcher !== watcher) return;
      io.emit('log', msg);
    },
    (statusInfo) => {
      if (activeWatcher !== watcher) return;
      lastStatus = statusInfo;
      io.emit('matchStatus', statusInfo);
    }
  );
  activeWatcher  = watcher;
  activeRecorder = recorder;

  res.json({ ok: true });
});

app.post('/stop', (req, res) => {
  if (activeWatcher) {
    stopActive();
    clearSnapshot();
    io.emit('matchStatus', { status: 'stopped', message: 'Scraper durduruldu.' });
    io.emit('log', 'Scraper durduruldu.');
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
