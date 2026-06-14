# Canlı Basketbol Maçı Scrape Algoritması

## 1. Başlangıç Süreci

- Kullanıcı maç linkini tanımlar.
- Scrape servisi, maç başlamadan önce çalışmaz.
- Bunun yerine sistem:
  - Her 3 saniyede bir sayfayı yeniler.
  - Maç durumunu kontrol eder.
- Kontrol edilen veri:
  - Periyot bilgisi (örnek: `1th Quarter` veya `0`)
- Eğer periyot:
  - `0` ise → maç başlamamıştır, kontrol devam eder.
  - `1th Quarter` olduğunda → maç başlamış kabul edilir.
- Bu noktada:
  - Ana scrape servisi başlatılır.

---

## 2. Ana Scrape Servisi

- Servis her 2 saniyede bir veri çeker.
- Çekilen veriler:
  - Maç zamanı / durumu (örnek: `4th Quarter 9'`)
  - Skor (örnek: `87 - 75`)
- Bu veriler ayrı değişkenlere atanır.

---

## 3. Veri Yapısı

- Başlangıçta 40 hücrelik bir dizi oluşturulur.
  - 4 periyot × 10 dakika = 40 dakika
- Uzatma durumunda dizi dinamik olarak genişler.
  - Her uzatma periyodu +5 hücre ekler.
  - Overflow kontrolü zorunludur.
- Her hücre ilgili dakikada atılan sayıları temsil eder.

---

## 4. Dakika Bazlı Skor Hesaplama

### 4.1 Temel Formül

Tüm dakikalar (ilk dakika dahil) aynı formülle hesaplanır:

```
n. dakika skoru = mevcut scoreboard toplamı - (n-1). dakikaya kadar olan kümülatif toplam
```

- İlk dakika için önceki kümülatif toplam `0` olduğundan scoreboard değeri direkt sonuç verir.
- Ayrı bir özel durum kuralı gerekmez.

### 4.2 Aynı Dakika İçinde Gelen Veriler

- 2 saniyede bir veri geldiği için aynı dakika içinde birden fazla scrape oluşur.
- Her yeni scrape, o dakikanın snapshot'ının **üzerine yazar** (toplanmaz).
- Dakika bittiğinde o dakikadaki **en son snapshot** geçerli kabul edilir.

```
1. scrape → A:2  B:5   ← üzerine yazılır
2. scrape → A:3  B:6   ← üzerine yazılır
3. scrape → A:6  B:6   ← dakika biterken son değer → geçerli snapshot
```

> **Not:** Kümülatif skor hiçbir zaman azalmaz. Azalan bir değer scrape hatası olarak değerlendirilmeli ve göz ardı edilmelidir.

### 4.3 Sonraki Dakikalar

- 2. dakikadan itibaren scoreboard toplam (kümülatif) skoru gösterir, direkt alınamaz.
- Doğru hesaplama:

```
n. dakika skoru = scoreboard toplamı - (n-1). dakikaya kadar olan kümülatif toplam
```

---

## 5. Dakika Geçişi

- Dakika değiştiğinde yeni hücreye yazım başlar.
- Önceki dakika sabitlenir ve değişmez.
- **Atlanan dakika kontrolü:** Scrape zamanlaması nedeniyle bir dakika atlanabilir.
  - Dakika değişimi fark edildiğinde atlanmış dakikalar tespit edilir.
  - Atlanmış hücreler bir önceki kümülatif skorla eşitlenir (o dakikada skor atılmadı kabul edilir).

```
Örnek:
- 7. dakika snapshot alındı
- Bir sonraki scrape'de 9. dakikaya geçildi
- 8. dakika hücresi → önceki kümülatif ile doldurulur (fark = 0)
- 9. dakika hücresi → normal formülle hesaplanır
```

---

## 6. Periyot Normalizasyonu

Scoreboard dakika bilgisi her periyotta `1'den 10'a` sıfırlanır. Hücre index hesabı için mutlak dakika kullanılmalıdır:

```
mutlakDakika = (periyot - 1) * 10 + dakika
hücreIndex   = mutlakDakika - 1
```

Örnek:

| Periyot | Dakika | Mutlak Dakika | Hücre Index |
|---------|--------|---------------|-------------|
| 1       | 3      | 3             | 2           |
| 2       | 3      | 13            | 12          |
| 3       | 7      | 27            | 26          |
| 4       | 10     | 40            | 39          |

---

## 7. Periyot ve Maç Durumu Kontrolü

Scrape sırasında karşılaşılabilecek durumlar:

- Periyot arası mola
- Maçın henüz başlamamış olması
- Maçın bitmiş olması

Bu durumlar yalnızca periyot yazısından kontrol edilir. Periyot bilgisi normalize edilerek maçın devam edip etmediği anlaşılır.

---

## 8. Genel Akış

```
1. Kullanıcı link girer
2. Her 3 sn'de maç başlangıcı kontrol edilir
3. "1th Quarter" algılandığında ana servis başlar
4. Her 2 sn'de veri çekilir:
   a. (periyot, dakika, homeScore, awayScore) parse edilir
   b. mutlakDakika = (periyot - 1) * 10 + dakika
   c. Dakika geçtiyse:
      - Atlanmış dakikalar varsa doldur
      - Hücre[mutlakDakika - 1] = scoreboard - öncekiKümülatif
      - öncekiKümülatif = scoreboard
   d. Aynı dakikadaysa snapshot üzerine yaz
5. Uzatmaya gidilirse dizi genişletilir
6. Periyot bilgisine göre maç durumu kontrol edilir
7. Maç bittiğinde servis durdurulur
```