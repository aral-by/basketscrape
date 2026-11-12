#!/usr/bin/env node
// Desktop launcher (BasketScrape.bat → here).
//   already running → just open the window
//   otherwise       → update from GitHub, start the server, open the window
'use strict';
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3010;
const URL = `http://localhost:${PORT}`;

function isRunning() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/model`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  if (await isRunning()) {
    console.log('BasketScrape zaten açık, pencere açılıyor.');
    require(path.join(ROOT, 'src', 'openApp')).openApp(URL);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  if (process.env.BASKETSCRAPE_NO_UPDATE !== '1') {
    console.log('Güncellemeler kontrol ediliyor…');
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'update.js'), '--dir', ROOT], { stdio: 'inherit' });
  }
  process.env.OPEN_BROWSER = process.env.OPEN_BROWSER || '1';
  console.log('\n  BasketScrape çalışıyor. Bu pencereyi KAPATMAYIN — kapatınca program durur.\n');
  require(path.join(ROOT, 'src', 'server.js'));   // freshly updated code
})();
