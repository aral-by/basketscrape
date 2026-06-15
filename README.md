# BasketScrape

Flashscore üzerinden canlı basketbol maçlarını gerçek zamanlı takip eden, dakika bazlı skor analizi ve istatistik görselleştirme sunan web uygulaması.

---

## Özellikler

- Flashscore maç linki girerek canlı veri çekme başlatılır
- Arka planda her 2 saniyede bir scrape yapılır
- Skorlar dakika bazında tabloya işlenir, grafikler anlık güncellenir
- Maç ortasından başlansa bile ilk hücre sıfır olarak işlenir (baseline koruması)
- İstatistik verisi olmayan maçlarda sarı uyarı banner'ı gösterilir
- **Maçtan Çık** butonu ile aktif scraper durdurulup yeni maç başlatılabilir

---

## Kurulum

```bash
npm install
npm start
```

Tarayıcıda aç: `http://localhost:3010`

### Çoklu Örnek Kurulumu

Aynı anda farklı portlarda birden fazla instance çalıştırmak için:

```
kurulum.bat
```

`basketscrape-3020`, `basketscrape-3030`, `basketscrape-3040`, `basketscrape-3050` klasörlerini oluşturur, her birinde port ayarlı `start.bat` hazırlar.

---

## Kullanım

1. Ana sayfaya Flashscore maç linki yapıştır
2. **Başlat** butonuna tıkla
3. Maç başlayınca `analysis.html` sayfası otomatik güncellenir
4. Sol sidebar'dan analiz sekmeleri arasında geçiş yapılır
5. Farklı bir maça geçmek için sidebar altındaki **Maçtan Çık** butonuna bas

---

## Proje Yapısı

```
basketscrape/
├── src/
│   ├── server.js        # Express + Socket.IO sunucu, /start ve /stop endpoint'leri
│   ├── scraper.js       # Puppeteer tabanlı Flashscore scraper
│   └── gameState.js     # Dakika bazlı skor hesaplama motoru
├── public/
│   ├── index.html       # Maç linki giriş sayfası
│   ├── app.js           # index.html socket handler
│   ├── analysis.html    # Ana analiz sayfası (sidebar + 9 sekme)
│   └── analysis.js      # Tablo, grafik ve metrik render mantığı
├── kurulum.bat          # Çoklu port kurulum scripti (3020/3030/3040/3050)
└── nixpacks.toml        # Railway.app deploy konfigürasyonu
```

---

## Analiz Sekmeleri

### Skor Tabloları
Periyot × Dakika formatında her takım için ayrı tablo:

| | 1 | 2 | 3 | ... | 10 |
|---|---|---|---|---|---|
| P1 | 3 | 0 | 5 | ... | |
| P2 | | | | | |

- **Gerçek tablo:** o dakikada atılan sayı
- **×40 tablo:** dakika değeri × 40 (normalize tempo)
- **Toplam tablo:** (ev + deplasman) × 40

### Grafikler
- Dakika bazlı ev sahibi vs deplasman çizgi grafiği
- Toplam tempo grafiği
- **Birleşik grafik:** her iki takım + toplam tek ekranda

### Four Factors (Dean Oliver)

| Metrik | Formül | Anlam |
|--------|--------|-------|
| eFG% | `(FGM + 0.5 × 3PM) / FGA` | 3'lük değeri hesaba katan şut verimliliği |
| TOV% | `TOV / (FGA + 0.44×FTA + TOV)` | Top kaybı oranı |
| ORB% | `ORB / (ORB + opp_DRB)` | Hücum ribaundu yakalama oranı |
| FTR  | `FTA / FGA` | Serbest atış üretim oranı |

### Verimlilik

| Metrik | Formül |
|--------|--------|
| OffRtg | `100 × (pts / avgPoss)` |
| DefRtg | Rakibin OffRtg'si |
| NetRtg | `OffRtg − DefRtg` |
| TS%    | `pts / (2 × (FGA + 0.44 × FTA))` |

### Şut Haritası
2'lik / 3'lük / Serbest Atış — isabet ve ıskalama katmanlı bar grafiği.

### Hücum/Savunma
Tahmini hücum sayısı: `FGA − ORB + TOV + 0.44 × FTA`

### İstatistikler
Flashscore istatistik sekmesindeki ham veriler.

### Isı Haritası
Periyot × Dakika canvas bazlı ısı haritası — her takım için ayrı, sayı yok sadece yoğunluk rengi.

### Parametreler
Tahmin motoru sekmesi:

- **Periyot temposu:** P1/P2/P3/P4 başına atılan sayı barları
- **Düzenli Düşüş deseni:** P1 > P2 ise P3 > P4 beklentisi analizi
- **3. Periyot 5. Dakika Tahmin Motoru:** Q3 dk5'ten itibaren kilidi açılır

#### Tahmin Formülü

```
1. Ham projeksiyon  = (Q3dk5 kümülatif toplam / 25) × 40
2. Kalan gereksinim = projeksiyon - Q3dk5 toplam
3. Pencere (Q2dk5 → Q3dk5, 10 dk) hızı vs kalan (15 dk) hızı karşılaştırması
   → Pencere hızı > kalan hızı  ⟹  Üst ↑
   → Pencere hızı < kalan hızı  ⟹  Alt ↓
4. DD düzeltmesi (aktifse): final = projeksiyon - (P1 + P2 ortalama) / 4
```

---

## Teknik Notlar

**Skor hesaplama** (`gameState.js`): Flashscore kümülatif skor yayınlar. Dakikaya düşen sayıyı hesaplamak için `lastHomeSeen` / `lastAwaySeen` baseline takibi yapılır. Maç ortasından başlanırsa ilk güncelleme baseline olarak kaydedilir, hücre 0 kalır.

**İstatistik çözümleme** (`computeMetrics`): Flashscore stat etiketleri maç türüne ve dile göre değişebilir. `findStat` fonksiyonu Türkçe/İngilizce anahtar kelimelerle eşleşme dener. "Alan Golü" = toplam FG (2'lik değil), `resolveFg()` bunu otomatik ayırt eder.

**Puppeteer bulut:** `PUPPETEER_EXECUTABLE_PATH` env değişkeni set edilirse sistem Chromium'unu kullanır, aksi hâlde kendi indirdiği Chrome'u kullanır.

---

## Kullanılan Teknolojiler

| Paket | Versiyon | Kullanım |
|-------|----------|---------|
| express | ^5.2 | HTTP sunucu, statik dosya servisi |
| socket.io | ^4.8 | Gerçek zamanlı veri transferi |
| puppeteer | ^24 | Headless Chrome ile Flashscore scraping |
| chart.js | 4.4.2 (CDN) | Çizgi, radar, bar, doughnut grafikleri |
