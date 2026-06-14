const puppeteer = require('puppeteer');
const ScoreBoard = require('./gameState');

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

// "1. Çeyrek" → 1  |  "Q2" / "2nd Quarter" → 2  |  "1. Uzatma" / "OT1" → 5
function parseQuarter(text) {
  if (!text) return null;
  const t = text.trim();

  // Turkish: "1. Çeyrek", "2. Çeyrek" …
  const qTr = t.match(/^(\d+)\.\s*[Çç]eyrek/i);
  if (qTr) return parseInt(qTr[1]);

  // Turkish OT: "1. Uzatma", "2. Uzatma" …
  const otTr = t.match(/^(\d+)\.\s*[Uu]zatma/i);
  if (otTr) return 4 + parseInt(otTr[1]);
  if (/uzatma/i.test(t)) return 5;

  // English abbreviated: "Q1" … "Q4"
  const qEn = t.match(/^Q(\d+)$/i);
  if (qEn) return parseInt(qEn[1]);

  // English long: "1st Quarter", "2nd Quarter", "3rd Quarter", "4th Quarter"
  const qEnLong = t.match(/^(\d+)[a-z]{0,2}\s*quarter/i);
  if (qEnLong) return parseInt(qEnLong[1]);

  // English OT: "OT", "OT1", "OT2" …
  const otEn = t.match(/^OT(\d*)$/i);
  if (otEn) return 4 + (parseInt(otEn[1]) || 1);

  // Numeric only (some layouts just show "1", "2" …)
  const bare = t.match(/^(\d)$/);
  if (bare) return parseInt(bare[1]);

  return null;
}

function isMatchFinished(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return t === 'bitti' || t === 'ms' || t === 'final' || t === 'ended' ||
    t.includes('bitti') || t.includes('finish') || t.includes('final') ||
    t.includes('ended') || t.includes('maç sonu');
}

function isHalftime(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return t.includes('devre') || t === 'iy' || t === 'ht' ||
    t.includes('half') || t.includes('break') || t.includes('interval');
}

async function parseMatchData(page, log) {
  const periodText = await getElementText(page, SELECTORS.period);
  const minuteText = await getElementText(page, SELECTORS.minute);
  const homeText   = await getElementText(page, SELECTORS.homeScore);
  const awayText   = await getElementText(page, SELECTORS.awayScore);

  const period    = parseQuarter(periodText);

  // Flashscore bazen period + dakikayı tek string'de birleştirir: "2. Çeyrek6'"
  // Önce ayrı minute selector'ı dene; bulamazsan period text'inden çek.
  let minute = minuteText ? (parseInt(minuteText) || null) : null;
  if (minute === null && periodText) {
    const m = periodText.match(/(\d+)['']?\s*$/);
    if (m) minute = parseInt(m[1]);
  }

  const homeScore = homeText   ? (parseInt(homeText.replace(/\D/g, '')) || 0) : null;
  const awayScore = awayText   ? (parseInt(awayText.replace(/\D/g, '')) || 0) : null;
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

// onStatus({ status: 'not_started'|'running'|'finished'|'error', homeName, awayName, message })
async function startWatcher(url, onUpdate, onEnd, onLog, onStatus) {
  const log    = onLog    || (() => {});
  const status = onStatus || (() => {});
  let browser = null;
  let stopped = false;
  let mainLoopTimer = null;
  let watchTimer = null;

  const scoreBoard = new ScoreBoard();
  let lastStats        = null;
  let lastStatsFetchAt = 0;
  const STATS_INTERVAL = 30_000; // ms

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

    const homeName = (await getElementText(page, SELECTORS.homeName)) || 'Ev Sahibi';
    const awayName = (await getElementText(page, SELECTORS.awayName)) || 'Misafir';
    log(`Takımlar: ${homeName} - ${awayName}`);

    const initialData = await parseMatchData(page, log);

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
          const data = await parseMatchData(page, log);
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

    log('İlk istatistikler alınıyor...');
    lastStats        = await fetchStats(page);
    lastStatsFetchAt = Date.now();
    if (lastStats) log('İstatistikler alındı.');

    async function mainLoop() {
      if (stopped) return;
      try {
        const now = Date.now();
        if (now - lastStatsFetchAt >= STATS_INTERVAL) {
          const fresh = await fetchStats(page);
          if (fresh) {
            lastStats        = fresh;
            lastStatsFetchAt = now;
            log('İstatistikler güncellendi.');
          }
        }

        const data = await parseMatchData(page, log);

        if (data.finished) {
          log('Maç bitti.');
          status({ status: 'finished', homeName, awayName, message: 'Maç sona erdi.' });
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
