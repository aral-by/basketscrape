const puppeteer = require('puppeteer');
const ScoreBoard = require('./gameState');
const { parseQuarter, parseMinute, parseScore, isMatchFinished, isHalftime } = require('./parse');

// CSS selectors tried left-to-right; first non-empty match wins.
// When Flashscore updates their DOM, prepend the new selector to the relevant array
// instead of replacing — this keeps backwards compatibility with older layouts.
// XPath selectors are prefixed with '/' and handled separately in getElementText().
// CSS selectors are tried first (more resilient); XPaths are fallbacks.
//
// Flashscore DOM değişim geçmişi:
//   2024-öncesi : main/div[5]/...
//   2025+       : main/div[4]/... (bir üst div kalktı)
//   Devre arası : div[2]/div/span  (normal oyunda div[2]/span[1])
const BASE = '/html/body/div[4]/div[1]/div/div/main/div[4]/div[1]/div[2]/div[1]';

const SELECTORS = {
  homeName: [
    '.duelParticipant__home .participant__participantName',
    '[class*="duelParticipant__home"] [class*="participantName"]',
    '[class*="home"] [class*="participantName"]',
    `${BASE}/div[2]/div[3]/div[2]/a`,   // XPath fallback (takım adı linki)
  ],
  awayName: [
    '.duelParticipant__away .participant__participantName',
    '[class*="duelParticipant__away"] [class*="participantName"]',
    '[class*="away"] [class*="participantName"]',
    `${BASE}/div[4]/div[3]/div[1]/a`,   // XPath fallback
  ],
  homeScore: [
    '.detailScore__wrapper > span:first-child',
    '[class*="detailScore__wrapper"] > span:first-child',
    '[class*="homeScore"]',
    `${BASE}/div[3]/div/div[1]/span[1]`,  // XPath fallback
  ],
  awayScore: [
    '.detailScore__wrapper > span:last-child',
    '[class*="detailScore__wrapper"] > span:last-child',
    '[class*="awayScore"]',
    `${BASE}/div[3]/div/div[1]/span[3]`,  // XPath fallback
  ],
  // Period text: "1. Çeyrek" / "Q2" / "Devre Arası" / "1. Uzatma" …
  // Devre arası DOM: div[2]/div/span  — normal oyun DOM: div[2]/span[1]
  // İkisi de kapsanıyor; CSS selector'lar her ikisini de yakalar.
  period: [
    '.smh__stage',
    '[class*="smh__stage"]',
    '[class*="matchStatusStage"]',
    '[class*="detailScore__status"] [class*="stage"]',
    '[class*="status"] > span:first-child',
    // Kullanıcı doğruladı: hem normal çeyrek hem devre arası aynı yapı → div/span[1]
    `${BASE}/div[3]/div/div[2]/div/span[1]`,
  ],
  minute: [
    // 2025 sonu DOM: <div class="detailScore__status"><span class="fixedHeaderDuel__detailStatus">3. Çeyrek</span><span class="eventTime">2<span class="event__timeIndicator">'</span></span></div>
    '.detailScore__status .eventTime',
    '[class*="eventTime"]',
    '.smh__minute',
    '[class*="smh__minute"]',
    '[class*="minuteWrapper"] > span:first-child',
    '[class*="timer"] > span:first-child',
    `${BASE}/div[3]/div/div[2]/div/span[2]`,   // XPath fallback (aynı div içinde span[2])
  ],
  statsTab: [
    '[data-testid="wcl-tab-statistics"]',
    'a[href*="statistics"] button',
    'a[href*="statistics"]',
    '.tabs a:nth-child(3)',
    `/html/body/div[4]/div[1]/div/div/main/div[4]/div[1]/div[5]/div[1]/div/a[3]/button`,
  ],
};

// Returns text content of the first selector that finds a non-empty element.
// Strings starting with '/' are treated as XPath; others as CSS selectors.
async function getElementText(page, selectors) {
  for (const sel of selectors) {
    try {
      let text;
      if (sel.startsWith('/')) {
        text = await page.evaluate((xp) => {
          const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          return node ? node.textContent.trim() : null;
        }, sel);
      } else {
        text = await page.$eval(sel, el => el.textContent.trim());
      }
      if (text) return text;
    } catch {}
  }
  return null;
}

// Clicks the first selector that resolves to an element. Returns true on success.
// Strings starting with '/' are treated as XPath; others as CSS selectors.
async function clickElement(page, selectors) {
  for (const sel of selectors) {
    try {
      if (sel.startsWith('/')) {
        const clicked = await page.evaluate((xp) => {
          const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (node) { node.click(); return true; }
          return false;
        }, sel);
        if (clicked) return true;
      } else {
        await page.click(sel);
        return true;
      }
    } catch {}
  }
  return false;
}

// When critical selectors fail, dump nearby elements to help identify new selectors.
async function debugPageState(page, log) {
  try {
    const snapshot = await page.evaluate(() => {
      const hits = [];
      document.querySelectorAll('[class]').forEach(el => {
        const txt = el.textContent.trim();
        if (!txt || txt.length > 50) return;
        const cls = el.getAttribute('class') || '';
        if (/score|stage|status|period|quarter|minute|time|çeyrek|devre/i.test(cls + txt)) {
          hits.push(`<${el.tagName.toLowerCase()} class="${cls.split(' ')[0]}">${txt}</${el.tagName.toLowerCase()}>`);
        }
      });
      return [...new Set(hits)].slice(0, 20);
    });
    log('[DEBUG] Sayfada bulunan elementler:\n' + (snapshot.join('\n') || '  — hiçbir şey bulunamadı'));
  } catch {}
}

async function parseMatchData(page, log) {
  const periodText = await getElementText(page, SELECTORS.period);
  const minuteText = await getElementText(page, SELECTORS.minute);
  const homeText   = await getElementText(page, SELECTORS.homeScore);
  const awayText   = await getElementText(page, SELECTORS.awayScore);

  const period    = parseQuarter(periodText);
  // Flashscore bazen period + dakikayı tek string'de birleştirir: "2. Çeyrek6'"
  const minute    = parseMinute(minuteText, periodText);
  const homeScore = parseScore(homeText);
  const awayScore = parseScore(awayText);
  const finished  = isMatchFinished(periodText);
  const halftime  = isHalftime(periodText);

  // Log when period selector returns nothing so we can detect future DOM changes early
  if (!periodText && log) {
    log('[UYARI] period selector hiçbir şey bulamadı — Flashscore DOM değişmiş olabilir.');
    await debugPageState(page, log);
  }

  return { periodText, period, minute, homeScore, awayScore, finished, halftime };
}

// Clicks the statistics tab and returns structured section data.
// Returns: [ { title, rows: [ { name, home, away } ] } ] or null on failure.
async function fetchStats(page) {
  try {
    const clicked = await clickElement(page, SELECTORS.statsTab);
    if (!clicked) return null;

    // Wait for at least one statistics row instead of a fixed timeout
    try {
      await page.waitForSelector('[data-testid="wcl-statistics"]', { timeout: 5000 });
    } catch {
      // Selector not found within 5 s; try to parse whatever is on the page
    }

    return await page.evaluate(() => {
      const sections = [];
      document.querySelectorAll('.section').forEach(sectionEl => {
        const titleEl = sectionEl.querySelector('.sectionHeader, .stat__header');
        const title   = titleEl ? titleEl.textContent.trim() : '';
        const rows    = [];
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
  } catch {
    return null;
  }
}


const MAIN_INTERVAL       = 2_000;   // ana döngü: her 2 sn skor okuma
const START_POLL_INTERVAL = 10_000;  // maç başlamadıysa sayfayı bu aralıkla yenile
const STATS_INTERVAL      = 30_000;  // istatistik sekmesi yenileme aralığı
const STALE_RELOAD_MS     = 120_000; // skor/dakika bu kadar süre değişmezse sayfayı yenile
const MAX_CONSECUTIVE_ERRORS = 5;    // bu kadar ardışık hatada tarayıcıyı yeniden başlat

// networkidle2 Flashscore'da (reklam, websocket) sık zaman aşımına düşer.
// Zaman aşımında sayfa genelde kullanılabilir durumdadır → hata atmak yerine devam et.
async function loadPage(page, url, log, timeout) {
  try {
    if (url) await page.goto(url, { waitUntil: 'networkidle2', timeout });
    else     await page.reload({ waitUntil: 'networkidle2', timeout });
  } catch (e) {
    if (e.name !== 'TimeoutError') throw e;
    log('Sayfa tam yüklenmedi (zaman aşımı), mevcut haliyle devam ediliyor.');
  }
}

function isStarted(data) {
  // parseQuarter("Devre Arası") null döner; devre arasında bağlanılan maç da başlamış sayılır.
  return (data.period && data.period >= 1) || data.halftime;
}

// Maçı izlemeye başlar ve { stop } nesnesini HEMEN döndürür. Tarayıcı açma, maçın başlamasını
// bekleme ve ana döngü arka planda çalışır; böylece maç başlamadan da stop() çağrılabilir.
//
// onStatus({ status: 'not_started'|'running'|'finished'|'error', homeName, awayName, message })
// onEnd yalnızca maç kendiliğinden bittiğinde veya hata oluştuğunda çağrılır, stop() ile değil.
// opts: zamanlama sabitlerini geçersiz kılmak için (testlerde kullanılır).
function startWatcher(url, onUpdate, onEnd, onLog, onStatus, opts = {}) {
  const {
    mainInterval      = MAIN_INTERVAL,
    startPollInterval = START_POLL_INTERVAL,
    statsInterval     = STATS_INTERVAL,
    staleReloadMs     = STALE_RELOAD_MS,
  } = opts;
  const log    = onLog    || (() => {});
  const status = onStatus || (() => {});

  let browser = null;
  let page    = null;
  let stopped = false;
  let wakeTimer   = null;
  let wakeResolve = null;

  const scoreBoard = new ScoreBoard();
  let homeName = 'Ev Sahibi';
  let awayName = 'Misafir';
  let lastStats = null;

  // stop() çağrılınca hemen uyanan bekleme
  function sleep(ms) {
    return new Promise(resolve => {
      if (stopped) return resolve();
      wakeResolve = resolve;
      wakeTimer   = setTimeout(resolve, ms);
    });
  }

  function closeBrowser() {
    const b = browser;
    browser = null;
    page    = null;
    if (b) b.close().catch(() => {});
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(wakeTimer);
    if (wakeResolve) wakeResolve();
    closeBrowser();
  }

  function finish(result) {
    if (stopped) return;
    stop();
    onEnd(result);
  }

  async function openBrowser() {
    closeBrowser();
    const b = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    if (stopped) { b.close().catch(() => {}); return; }

    browser = b;
    b.on('disconnected', () => {
      if (browser !== b) return; // bilerek kapatıldı
      browser = null;
      page    = null;
      if (!stopped) log('Tarayıcı bağlantısı koptu, yeniden açılacak.');
    });

    const p = await b.newPage();
    await p.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await p.setViewport({ width: 1280, height: 800 });
    log('Sayfa açılıyor...');
    await loadPage(p, url, log, 30_000);
    if (browser === b) page = p;
  }

  function finishedResult(reason) {
    return { reason, state: { ...scoreBoard.getState(), homeName, awayName, stats: lastStats } };
  }

  async function run() {
    await openBrowser();
    if (stopped) return;

    homeName = (await getElementText(page, SELECTORS.homeName)) || homeName;
    awayName = (await getElementText(page, SELECTORS.awayName)) || awayName;
    log(`Takımlar: ${homeName} - ${awayName}`);

    let data = await parseMatchData(page, log);
    if (stopped) return;

    if (data.finished) {
      log('Maç zaten bitmiş.');
      status({ status: 'finished', homeName, awayName, message: 'Bu maç sona ermiş.' });
      finish(finishedResult('already_finished'));
      return;
    }

    // ── Maçın başlamasını bekle ──
    if (!isStarted(data)) {
      log('Maç henüz başlamadı, bekleniyor...');
      status({ status: 'not_started', homeName, awayName, message: 'Maç henüz başlamadı.' });

      while (!stopped) {
        await sleep(startPollInterval);
        if (stopped) return;
        try {
          if (!page) await openBrowser();
          else       await loadPage(page, null, log, 15_000);
          if (stopped) return;
          data = await parseMatchData(page, log);
          log('Durum: ' + (data.periodText || '—'));
          if (data.finished) {
            status({ status: 'finished', homeName, awayName, message: 'Bu maç sona ermiş.' });
            finish(finishedResult('finished'));
            return;
          }
          if (isStarted(data)) {
            log('Maç başladı! ' + (data.periodText || 'Devre arası'));
            break;
          }
        } catch (e) {
          log('Kontrol hatası: ' + e.message);
        }
      }
    }
    if (stopped) return;

    log('Ana servis başladı.');
    status({ status: 'running', homeName, awayName, message: 'Maç devam ediyor.' });

    log('İlk istatistikler alınıyor...');
    lastStats = await fetchStats(page);
    let lastStatsFetchAt = Date.now();
    if (lastStats) log('İstatistikler alındı.');

    // ── Ana döngü ──
    let lastSignature = null;
    let lastChangeAt  = Date.now();
    let errors        = 0;

    while (!stopped) {
      try {
        if (!page) {
          log('Sayfa yeniden açılıyor...');
          await openBrowser();
          if (stopped) return;
          lastChangeAt = Date.now();
        }

        const now = Date.now();
        if (now - lastStatsFetchAt >= statsInterval) {
          const fresh = await fetchStats(page);
          if (fresh) {
            lastStats        = fresh;
            lastStatsFetchAt = now;
            log('İstatistikler güncellendi.');
          }
        }

        const data = await parseMatchData(page, log);
        if (stopped) return;
        errors = 0;

        if (data.finished) {
          log('Maç bitti.');
          status({ status: 'finished', homeName, awayName, message: 'Maç sona erdi.' });
          const finalStats = await fetchStats(page);
          if (finalStats) lastStats = finalStats;
          finish(finishedResult('finished'));
          return;
        }

        // Bayat sayfa tespiti: canlı güncellemeler durursa sayfayı yenile.
        // (Basketbolda saat sık durur; bu yüzden eşik 2 dakika, yenileme zararsız.)
        const signature = [data.periodText, data.minute, data.homeScore, data.awayScore].join('|');
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastChangeAt  = Date.now();
        } else if (Date.now() - lastChangeAt > staleReloadMs) {
          log('Uzun süredir değişiklik yok, sayfa yenileniyor...');
          await loadPage(page, null, log, 15_000);
          lastChangeAt = Date.now();
        }

        if (!data.halftime && data.period && data.minute !== null &&
            data.homeScore !== null && data.awayScore !== null) {
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
        if (stopped) return;
        errors++;
        log('Scrape hatası: ' + e.message);
        if (errors >= MAX_CONSECUTIVE_ERRORS) {
          log(`${errors} ardışık hata, tarayıcı yeniden başlatılacak.`);
          closeBrowser();
          errors = 0;
        }
      }

      await sleep(mainInterval);
    }
  }

  run().catch(e => {
    if (stopped) return;
    log('Watcher hatası: ' + e.message);
    status({ status: 'error', homeName, awayName, message: e.message });
    finish({ reason: 'error', error: e.message, state: scoreBoard.getState() });
  });

  return { stop };
}

module.exports = { startWatcher };
