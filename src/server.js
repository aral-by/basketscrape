const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { startWatcher } = require('./scraper');
const { isAllowedMatchUrl } = require('./parse');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let activeWatcher = null;

// Sonradan bağlanan sekmeler (örn. analiz sayfası) boş ekran görmesin diye son durum saklanır.
let lastStatus = null;
let lastUpdate = null;
let lastEnd    = null;

function clearSnapshot() {
  lastStatus = null;
  lastUpdate = null;
  lastEnd    = null;
}

io.on('connection', (socket) => {
  if (lastStatus) socket.emit('matchStatus', lastStatus);
  if (lastUpdate) socket.emit('scoreUpdate', lastUpdate);
  if (lastEnd)    socket.emit('matchEnd', lastEnd);
});

function stopActive() {
  if (activeWatcher) {
    activeWatcher.stop();
    activeWatcher = null;
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

  // startWatcher hemen döner; maçın başlamasını arka planda bekler.
  // Callback'ler yalnızca HÂLÂ aktif olan watcher içinse yayın yapar — eski bir
  // watcher'ın geç gelen olayları yenisinin durumunu ezmesin.
  const watcher = startWatcher(
    url,
    (state) => {
      if (activeWatcher !== watcher) return;
      lastUpdate = state;
      io.emit('scoreUpdate', state);
    },
    (result) => {
      if (activeWatcher !== watcher) return;
      lastEnd = result;
      activeWatcher = null;
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
  activeWatcher = watcher;

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
