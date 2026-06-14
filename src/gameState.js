class ScoreBoard {
  constructor() {
    this.reset();
  }

  reset() {
    this.homeMinutes = new Array(40).fill(0);
    this.awayMinutes = new Array(40).fill(0);
    this.prevHomeCumulative = 0;  // dakika başındaki kümülatif (overwrite için baseline)
    this.prevAwayCumulative = 0;
    this.lastHomeSeen = 0;        // en son görülen ham kümülatif (dakika sonu için)
    this.lastAwaySeen = 0;
    this.lastAbsoluteMinute = 0;
    this.totalCells = 40;
  }

  update(period, minute, homeScore, awayScore) {
    // Scrape hatası: kümülatif skor hiçbir zaman azalamaz
    if (homeScore < this.lastHomeSeen || awayScore < this.lastAwaySeen) {
      return false;
    }

    const absoluteMinute = (period - 1) * 10 + minute;

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

  _expandForOvertime(absoluteMinute) {
    while (this.totalCells < absoluteMinute) {
      this.totalCells += 5;
      for (let i = 0; i < 5; i++) {
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
