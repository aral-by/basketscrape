const puppeteer = require('puppeteer');
const ScoreBoard = require('./gameState');

const XPATHS = {
  homeName:  '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[2]/div[1]/div[2]/div[3]/div[2]/a',
  awayName:  '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[2]/div[1]/div[4]/div[3]/div[1]/a',
  homeScore: '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[2]/div[1]/div[3]/div/div[1]/span[1]',
  awayScore: '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[2]/div[1]/div[3]/div/div[1]/span[3]',
  period:    '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[2]/div[1]/div[3]/div/div[2]/span[1]',
  minute:    '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[2]/div[1]/div[3]/div/div[2]/span[2]',
  status:    '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[2]/div[1]/div[3]/div/div[2]/span',
  statsBtn:  '/html/body/div[4]/div[1]/div/div/main/div[5]/div[1]/div[5]/div[1]/div/a[3]/button',
};

async function getXPathText(page, xpath) {
  try {
    return await page.evaluate((xp) => {
      const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = result.singleNodeValue;
      return node ? node.textContent.trim() : null;
    }, xpath);
  } catch {
    return null;
  }
}

// "1. Çeyrek" → 1, "4. Çeyrek" → 4, "1. Uzatma" → 5
function parseQuarter(text) {
  if (!text) return null;
  const t = text.trim();
  const qMatch = t.match(/^(\d+)\.\s*[Çç]eyrek/i);
  if (qMatch) return parseInt(qMatch[1]);
  const otMatch = t.match(/^(\d+)\.\s*[Uu]zatma/i);
  if (otMatch) return 4 + parseInt(otMatch[1]);
  if (/uzatma/i.test(t)) return 5;
  return null;
}

function isMatchFinished(text) {
  if (!text) return false;
  const t = text.trim();
  if (t === 'Bitti') return true;
  const tl = t.toLowerCase();
  return tl === 'ms' || tl.includes('bitti') || tl.includes('finish') || tl.includes('final') || tl.includes('ended') || tl.includes('maç sonu');
}

function isHalftime(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return t.includes('devre') || t === 'iy' || t.includes('half') || t.includes('break');
}

async function parseMatchData(page) {
  const periodText = await getXPathText(page, XPATHS.period);
  const minuteText = await getXPathText(page, XPATHS.minute);
  const homeText   = await getXPathText(page, XPATHS.homeScore);
  const awayText   = await getXPathText(page, XPATHS.awayScore);

  const period    = parseQuarter(periodText);
  const minute    = minuteText ? (parseInt(minuteText) || null) : null;
  const homeScore = homeText   ? (parseInt(homeText.replace(/\D/g, '')) || 0) : null;
  const awayScore = awayText   ? (parseInt(awayText.replace(/\D/g, '')) || 0) : null;
  const finished  = isMatchFinished(periodText);
  const halftime  = isHalftime(periodText);

  return { periodText, period, minute, homeScore, awayScore, finished, halftime };
}

// İstatistik sekmesine geçip tüm verileri section gruplu olarak döndür
// Dönüş: [ { title, rows: [ { name, home, away } ] } ]
async function fetchStats(page) {
  try {
    // İstatistikler sekmesi butonuna tıkla
    await page.evaluate((xp) => {
      const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = result.singleNodeValue;
      if (node) node.click();
    }, XPATHS.statsBtn);

    // İçerik yüklensin
    await new Promise(r => setTimeout(r, 1500));

    return await page.evaluate(() => {
      const sections = [];

      // Her section div'ini bul
      document.querySelectorAll('.section').forEach(sectionEl => {
        const titleEl = sectionEl.querySelector('.sectionHeader, .stat__header');
        const title   = titleEl ? titleEl.textContent.trim() : '';

        const rows = [];
        sectionEl.querySelectorAll('[data-testid="wcl-statistics"]').forEach(rowEl => {
          const values   = rowEl.querySelectorAll('[data-testid="wcl-statistics-value"]');
          const category = rowEl.querySelector('[data-testid="wcl-statistics-category"]');
          if (values.length >= 2 && category) {
            rows.push({
              name: category.textContent.trim(),
              home: values[0].textContent.trim(),
              away: values[1].textContent.trim(),
            });
          }
        });

        if (rows.length > 0) sections.push({ title, rows });
      });

      return sections;
    });
  } catch (e) {
    return null;
  }
}

// onStatus({ status: 'not_started'|'running'|'finished'|'error', homeName, awayName, message })
async function startWatcher(url, onUpdate, onEnd, onLog, onStatus) {
  const log    = onLog    || (() => {});
  const status = onStatus || (() => {});
  let browser = null;
  let stopped = false;
  let mainLoopTimer = null;
  let watchTimer = null;

  const scoreBoard = new ScoreBoard();
  let lastStats         = null;
  let lastStatsFetchAt  = 0;
  const STATS_INTERVAL  = 30_000; // 30 sn

  function stop() {
    stopped = true;
    clearTimeout(mainLoopTimer);
    clearTimeout(watchTimer);
    if (browser) browser.close().catch(() => {});
  }

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    log('Sayfa açılıyor...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const homeName = (await getXPathText(page, XPATHS.homeName)) || 'Ev Sahibi';
    const awayName = (await getXPathText(page, XPATHS.awayName)) || 'Misafir';
    log(`Takımlar: ${homeName} - ${awayName}`);

    const initialData = await parseMatchData(page);

    if (initialData.finished) {
      log('Maç zaten bitmiş.');
      status({ status: 'finished', homeName, awayName, message: 'Bu maç sona ermiş.' });
      onEnd({ reason: 'already_finished', state: scoreBoard.getState(), homeName, awayName });
      stop();
      return { stop };
    }

    if (!initialData.period) {
      log('Maç henüz başlamadı, bekleniyor...');
      status({ status: 'not_started', homeName, awayName, message: 'Maç henüz başlamadı.' });
    }

    await new Promise((resolve, reject) => {
      async function checkStart() {
        if (stopped) return reject(new Error('stopped'));
        try {
          await page.reload({ waitUntil: 'networkidle2', timeout: 15000 });
          const data = await parseMatchData(page);
          log('Durum: ' + (data.periodText || '—'));
          if (data.finished) {
            status({ status: 'finished', homeName, awayName, message: 'Bu maç sona ermiş.' });
            reject(new Error('Maç bitti.'));
            return;
          }
          if (data.period && data.period >= 1) {
            log('Maç başladı! ' + data.periodText);
            resolve();
            return;
          }
        } catch (e) {
          log('Kontrol hatası: ' + e.message);
        }
        watchTimer = setTimeout(checkStart, 3000);
      }
      if (initialData.period && initialData.period >= 1) {
        resolve();
      } else {
        checkStart();
      }
    });

    if (stopped) return { stop };

    log('Ana servis başladı.');
    status({ status: 'running', homeName, awayName, message: 'Maç devam ediyor.' });

    // Maç başlar başlamaz ilk istatistikleri çek
    log('İlk istatistikler alınıyor...');
    lastStats        = await fetchStats(page);
    lastStatsFetchAt = Date.now();
    if (lastStats) log('İstatistikler alındı.');

    async function mainLoop() {
      if (stopped) return;
      try {
        // Her 30 sn'de istatistikleri güncelle
        const now = Date.now();
        if (now - lastStatsFetchAt >= STATS_INTERVAL) {
          const fresh = await fetchStats(page);
          if (fresh) {
            lastStats        = fresh;
            lastStatsFetchAt = now;
            log('İstatistikler güncellendi.');
          }
        }

        const data = await parseMatchData(page);

        if (data.finished) {
          log('Maç bitti.');
          status({ status: 'finished', homeName, awayName, message: 'Maç sona erdi.' });
          // Son istatistikleri de çek
          const finalStats = await fetchStats(page);
          onEnd({ reason: 'finished', state: { ...scoreBoard.getState(), homeName, awayName, stats: finalStats || lastStats } });
          stop();
          return;
        }

        if (!data.halftime && data.period && data.minute !== null && data.homeScore !== null) {
          scoreBoard.update(data.period, data.minute, data.homeScore, data.awayScore);
          onUpdate({
            ...scoreBoard.getState(),
            homeName, awayName,
            periodText: data.periodText,
            minute:     data.minute,
            homeScore:  data.homeScore,
            awayScore:  data.awayScore,
            stats:      lastStats,
          });
        } else {
          log('Bekleniyor: ' + (data.periodText || '—'));
        }
      } catch (e) {
        log('Scrape hatası: ' + e.message);
      }

      mainLoopTimer = setTimeout(mainLoop, 2000);
    }

    mainLoop();
  } catch (e) {
    log('Watcher hatası: ' + e.message);
    status({ status: 'error', message: e.message });
    onEnd({ reason: 'error', error: e.message, state: scoreBoard.getState() });
    if (browser) browser.close().catch(() => {});
  }

  return { stop };
}

module.exports = { startWatcher };
