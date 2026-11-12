// Bir periyodun kaç dakika olduğu: 4 normal çeyrek 10'ar dk, her uzatma 5 dk.
const QUARTER_MINUTES  = 10;
const OVERTIME_MINUTES = 5;
const REGULATION_CELLS = 4 * QUARTER_MINUTES; // 40

// Skorun bu kadar (veya daha az) düşmesi Flashscore düzeltmesi sayılır
// (örn. 3'lük → 2'lik). Daha büyük düşüşler scrape hatasıdır, yok sayılır.
const MAX_CORRECTION = 3;

// (periyot, periyot içi dakika) → 1 tabanlı mutlak dakika.
// Q1-Q4: 1-40, 1. uzatma: 41-45, 2. uzatma: 46-50 …
function toAbsoluteMinute(period, minute) {
  if (period <= 4) return (period - 1) * QUARTER_MINUTES + minute;
  return REGULATION_CELLS + (period - 5) * OVERTIME_MINUTES + minute;
}

class ScoreBoard {
  constructor() {
    this.reset();
  }

  reset() {
    this.homeMinutes = new Array(REGULATION_CELLS).fill(0);
    this.awayMinutes = new Array(REGULATION_CELLS).fill(0);
    this.prevHomeCumulative = 0;  // dakika başındaki kümülatif (overwrite için baseline)
    this.prevAwayCumulative = 0;
    this.lastHomeSeen = 0;        // en son görülen ham kümülatif (dakika sonu için)
    this.lastAwaySeen = 0;
    this.lastAbsoluteMinute = 0;
    this.totalCells = REGULATION_CELLS;
  }

  update(period, minute, homeScore, awayScore) {
    const periodLength = period <= 4 ? QUARTER_MINUTES : OVERTIME_MINUTES;
    if (!(period >= 1) || !(minute >= 1) || minute > periodLength) return false;

    const absoluteMinute = toAbsoluteMinute(period, minute);

    if (this.lastAbsoluteMinute !== 0) {
      // Zaman geriye gidemez: geriye dönük bir dakika scrape hatasıdır.
      if (absoluteMinute < this.lastAbsoluteMinute) return false;

      // Büyük skor düşüşü = scrape hatası (örn. "-" → 0 okunması). Tüm okumayı reddet.
      if (this.lastHomeSeen - homeScore > MAX_CORRECTION ||
          this.lastAwaySeen - awayScore > MAX_CORRECTION) {
        return false;
      }

      // Küçük düşüş = Flashscore skor düzeltmesi. Fazla sayılan sayıları
      // geçmiş hücrelerden geri al; diğer takımın verisine dokunma.
      if (homeScore < this.lastHomeSeen) this._applyCorrection('home', homeScore);
      if (awayScore < this.lastAwaySeen) this._applyCorrection('away', awayScore);
    }

    if (absoluteMinute > this.totalCells) {
      this._expandForOvertime(absoluteMinute);
    }

    const cellIndex = absoluteMinute - 1;

    if (this.lastAbsoluteMinute === 0) {
      // İLK GÜNCELLEME — scraper maç ortasından başlamış olabilir.
      // Mevcut skoru baseline olarak kaydet; bu dakikanın hücresi 0 kalır
      // (geriye dönük bilgi yok, o dakikada tam kaç sayı atıldığı bilinmez).
      this.prevHomeCumulative = homeScore;
      this.prevAwayCumulative = awayScore;
      this.lastHomeSeen       = homeScore;
      this.lastAwaySeen       = awayScore;
      this.lastAbsoluteMinute = absoluteMinute;
      return true;
    }

    if (absoluteMinute === this.lastAbsoluteMinute) {
      // Aynı dakika içinde yeni snapshot: üzerine yaz
      // prevXCumulative = bu dakikanın başındaki kümülatif → değişmez
      this.homeMinutes[cellIndex] = homeScore - this.prevHomeCumulative;
      this.awayMinutes[cellIndex] = awayScore - this.prevAwayCumulative;
    } else {
      // Dakika geçişi: atlanan dakikaları sıfırla
      for (let m = this.lastAbsoluteMinute + 1; m < absoluteMinute; m++) {
        this.homeMinutes[m - 1] = 0;
        this.awayMinutes[m - 1] = 0;
      }

      // Yeni dakikayı hesapla: lastXSeen = bir önceki dakikanın sonu
      this.homeMinutes[cellIndex] = homeScore - this.lastHomeSeen;
      this.awayMinutes[cellIndex] = awayScore - this.lastAwaySeen;

      // Yeni dakikanın başlangıç kümülatifi = bir önceki dakikanın sonu
      this.prevHomeCumulative = this.lastHomeSeen;
      this.prevAwayCumulative = this.lastAwaySeen;
    }

    this.lastHomeSeen       = homeScore;
    this.lastAwaySeen       = awayScore;
    this.lastAbsoluteMinute = absoluteMinute;
    return true;
  }

  // Skor düşürüldüğünde farkı en yeni hücrelerden başlayarak geri siler.
  // Hücrelere sığmayan kısım (scraper maç ortasında başladıysa) baseline'dan düşülür.
  // Değişmez kural: prevCumulative + minutes[şimdiki hücre] === lastSeen
  _applyCorrection(side, newScore) {
    const isHome  = side === 'home';
    const minutes = isHome ? this.homeMinutes : this.awayMinutes;
    const lastSeen = isHome ? this.lastHomeSeen : this.lastAwaySeen;
    const currentIndex = this.lastAbsoluteMinute - 1;

    let remaining = lastSeen - newScore;
    let removedBeforeCurrent = 0;

    for (let i = currentIndex; i >= 0 && remaining > 0; i--) {
      const take = Math.min(minutes[i], remaining);
      minutes[i] -= take;
      remaining  -= take;
      if (i < currentIndex) removedBeforeCurrent += take;
    }
    removedBeforeCurrent += remaining; // baseline'dan düşülen kısım

    if (isHome) {
      this.lastHomeSeen = newScore;
      this.prevHomeCumulative -= removedBeforeCurrent;
    } else {
      this.lastAwaySeen = newScore;
      this.prevAwayCumulative -= removedBeforeCurrent;
    }
  }

  _expandForOvertime(absoluteMinute) {
    while (this.totalCells < absoluteMinute) {
      this.totalCells += OVERTIME_MINUTES;
      for (let i = 0; i < OVERTIME_MINUTES; i++) {
        this.homeMinutes.push(0);
        this.awayMinutes.push(0);
      }
    }
  }

  getState() {
    return {
      homeMinutes: [...this.homeMinutes],
      awayMinutes: [...this.awayMinutes],
      totalCells: this.totalCells,
      lastAbsoluteMinute: this.lastAbsoluteMinute,
    };
  }
}

module.exports = ScoreBoard;
module.exports.toAbsoluteMinute = toAbsoluteMinute;
