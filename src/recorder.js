// İzlenen her maçı ML eğitimi için diske kaydeder (data/matches/<tarih>_<maçId>.json).
//
// Kaydın temel verisi `cumulative`: her mutlak dakikanın SONUNDA tabelada görülen skor
// (o dakikadaki son okuma). Dakika başı sayılar buradan türetilebilir, tersi mümkün değildir:
// maç ortasında başlanmışsa dakika tablosu baseline'ı kaybeder ama kümülatif skor kaybetmez.
// Gözlenmeyen dakikalar null kalır.
//
// Aynı maç yeniden başlatılırsa (Yenile butonu, sunucu çökmesi) mevcut dosya okunur ve
// önceki oturumda gözlenmiş dakikalar korunur.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

// Flashscore maç kimliği: "?mid=pMWvS76T" veya eski biçimde "/match/pMWvS76T/".
function matchIdFromUrl(url) {
  try {
    const u = new URL(url);
    const mid = u.searchParams.get('mid');
    if (mid && /^[A-Za-z0-9]{6,12}$/.test(mid)) return mid;
    const seg = u.pathname.split('/').find(s => /^[A-Za-z0-9]{8}$/.test(s));
    if (seg) return seg;
  } catch {}
  return 'u' + crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

class MatchRecorder {
  constructor(url, { dir, now = () => new Date() } = {}) {
    this.dir = dir;
    this.now = now;
    fs.mkdirSync(dir, { recursive: true });

    const id = matchIdFromUrl(url);
    const existing = this._findExisting(id);
    const startedAt = now().toISOString();

    this.file = existing || path.join(dir, `${startedAt.slice(0, 10)}_${id}.json`);
    this.record = {
      schema: SCHEMA_VERSION,
      id,
      url,
      league: null,
      homeName: null,
      awayName: null,
      recordedAt: startedAt,
      updatedAt: startedAt,
      status: 'live',              // live | finished | stopped | error
      observedMinutes: 0,
      firstObservedMinute: null,
      cumulative: { home: [], away: [] }, // indeks = mutlak dakika - 1
      totalCells: 40,
      overtimePeriods: 0,
      regulation: null,            // { home, away } 40. dakika sonu (gözlendiyse)
      final: null,                 // { home, away } maç sonu (uzatmalar dahil)
      stats: null,
    };

    if (existing) this._mergeExisting(existing);
    this._lastSavedMinute = null;
  }

  _findExisting(id) {
    try {
      const name = fs.readdirSync(this.dir).find(f => f.endsWith(`_${id}.json`));
      return name ? path.join(this.dir, name) : null;
    } catch { return null; }
  }

  _mergeExisting(file) {
    try {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (old.schema !== SCHEMA_VERSION) return;
      this.record.recordedAt = old.recordedAt || this.record.recordedAt;
      this.record.cumulative = old.cumulative || this.record.cumulative;
      for (const k of ['league', 'homeName', 'awayName', 'stats', 'regulation', 'final']) {
        if (old[k] != null) this.record[k] = old[k];
      }
      this._recount();
    } catch {}
  }

  _recount() {
    const { home } = this.record.cumulative;
    let first = null, count = 0;
    home.forEach((v, i) => {
      if (v == null) return;
      count++;
      if (first === null) first = i + 1;
    });
    this.record.observedMinutes = count;
    this.record.firstObservedMinute = first;
    this.record.totalCells = Math.max(40, home.length);
    this.record.overtimePeriods = Math.max(0, Math.ceil((home.length - 40) / 5));
    if (home[39] != null) {
      this.record.regulation = { home: home[39], away: this.record.cumulative.away[39] };
    }
  }

  // scraper onUpdate payload'ı
  update(state) {
    const m = state.lastAbsoluteMinute;
    if (!m || state.homeScore == null || state.awayScore == null) return;

    const r = this.record;
    if (state.homeName) r.homeName = state.homeName;
    if (state.awayName) r.awayName = state.awayName;
    if (state.league)   r.league   = state.league;
    if (state.stats)    r.stats    = state.stats;

    const { home, away } = r.cumulative;
    while (home.length < m) { home.push(null); away.push(null); }
    home[m - 1] = state.homeScore;
    away[m - 1] = state.awayScore;
    this._recount();
    r.updatedAt = this.now().toISOString();

    // Diske yalnızca dakika değişince yaz (2 sn'de bir değil).
    if (this._lastSavedMinute !== m) {
      this._lastSavedMinute = m;
      this.save();
    }
  }

  // scraper onEnd payload'ı
  finish(result) {
    const r = this.record;
    const st = result.state || {};
    if (st.homeName) r.homeName = st.homeName;
    if (st.awayName) r.awayName = st.awayName;
    if (st.league)   r.league   = st.league;
    if (st.stats)    r.stats    = st.stats;

    if (result.reason === 'error') {
      r.status = 'error';
    } else {
      r.status = 'finished';
      if (result.final) r.final = result.final;
    }
    r.updatedAt = this.now().toISOString();
    this.save();
  }

  // Kullanıcı durdurdu: veri eksik ama gözlenen kısım yine de değerli.
  stop() {
    if (this.record.status === 'live') this.record.status = 'stopped';
    this.record.updatedAt = this.now().toISOString();
    this.save();
  }

  save() {
    // Hiç dakika gözlenmeden biten/durdurulan maç (örn. zaten bitmiş) için dosya bırakma.
    if (!this.record.observedMinutes) return;
    try {
      atomicWriteJson(this.file, this.record);
    } catch (e) {
      console.error('Kayıt yazılamadı:', e.message);
    }
  }
}

module.exports = { MatchRecorder, matchIdFromUrl, SCHEMA_VERSION };
