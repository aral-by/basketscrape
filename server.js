const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { startWatcher } = require('./scraper');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let activeWatcher = null;

app.post('/start', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  if (activeWatcher) {
    activeWatcher.stop();
    activeWatcher = null;
  }

  io.emit('log', 'Scraper başlatılıyor...');

  try {
    activeWatcher = await startWatcher(
      url,
      (state) => {
        io.emit('scoreUpdate', state);
      },
      (result) => {
        io.emit('matchEnd', result);
        activeWatcher = null;
      },
      (msg) => {
        io.emit('log', msg);
      },
      (statusInfo) => {
        io.emit('matchStatus', statusInfo);
      }
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/stop', (req, res) => {
  if (activeWatcher) {
    activeWatcher.stop();
    activeWatcher = null;
    io.emit('matchStatus', { status: 'stopped', message: 'Scraper durduruldu.' });
    io.emit('log', 'Scraper durduruldu.');
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
