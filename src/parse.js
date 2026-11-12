// Flashscore metinlerini ayrıştıran saf fonksiyonlar (Puppeteer'a bağımlı değil, test edilebilir).

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

// Dakikayı ayrı minute elementinden, bulunamazsa period metninin sonundan çeker:
// "6'" → 6  |  periodText "2. Çeyrek6'" / "2. Çeyrek 6’" → 6
function parseMinute(minuteText, periodText) {
  if (minuteText) {
    const n = parseInt(minuteText);
    if (n) return n;
  }
  if (periodText) {
    const m = periodText.match(/(\d+)\s*['’]?\s*$/);
    // "1. Çeyrek" gibi dakikasız metinlerde sondaki rakam yok; yalnızca rakamla biten metinler eşleşir.
    if (m && !/^\d+$/.test(periodText.trim())) return parseInt(m[1]);
  }
  return null;
}

function parseScore(text) {
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  return digits ? parseInt(digits) : null;
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

// Yalnızca Flashscore adreslerine izin ver (flashscore.com, flashscore.com.tr, flashscore.co.uk …).
// Aksi halde sunucudaki Chrome'a herhangi bir adres (iç ağ, file:// …) açtırılabilir.
function isAllowedMatchUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return /(^|\.)flashscore\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(u.hostname);
}

module.exports = { parseQuarter, parseMinute, parseScore, isMatchFinished, isHalftime, isAllowedMatchUrl };
