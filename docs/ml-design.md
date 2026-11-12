# ML Tasarımı: Canlı Maçta MS Toplam Skor Tahmini

## 1. Problem

Canlı bir FIBA maçında (4 × 10 dk), mutlak dakika `t`'de **maç sonu toplam skoru** (MS, uzatmalar dahil) tahmin et ve bu tahminin **3. periyodun hangi dakikasında** yapılması gerektiğini veriyle belirle.

| Sembol | Anlamı |
|---|---|
| `S_t` | t. dakika sonundaki toplam kümülatif skor (iki takım) |
| `r = 40 − t` | kalan normal süre |
| `y` | MS toplam (uzatmalar dahil) |
| `R_t = y − S_t` | kalan sayı; modellerin asıl tahmin ettiği büyüklük |

**Sızıntı yasağı:** `t` dakikasındaki satır yalnızca 1..t dakikalarının verisini kullanır (`ml/tests`'te test ediliyor).

> NBA (4 × 12 dk) ve NCAA (2 × 20 dk) şu an desteklenmiyor: canlı uygulama da 10 dakikalık çeyrek varsayıyor.

## 2. Veri

### Hangi veri nereden gelir?

| Veri | Kaynak | Geçmiş maçlarda var mı? |
|---|---|---|
| Dakika dakika kümülatif skor | Kendi canlı kayıtlarımız (`data/matches/*.json`) | **Hayır.** Flashscore'un sayı-sayı akışında zaman damgası yok (2026-11'de doğrulandı). |
| Çeyrek skorları | Flashscore maç özeti | Evet, bitmiş her maçta |
| Maç öncesi Alt/Üst baremi | Flashscore Oranlar sekmesi | Evet |

Bu yüzden 3. periyot içindeki dakika seçimi **yalnızca kendi kayıtlarımızla** cevaplanabilir. Kriter 1 gibi çeyrek bazlı sorular ise geçmiş veriyle hemen test edilebilir.

### Kayıt şeması

Kayıtlar `src/recorder.js` tarafından yazılır, şema sürümü 1:

- `cumulative.home[i]`, `cumulative.away[i]`: (i+1). dakikanın sonunda tabelada görülen skor. Gözlenmeyen dakika `null`.
- `final`: maç sonu skoru.
- `firstObservedMinute`: maça kaçıncı dakikada bağlanıldığı.
- `pregameLine` (opsiyonel): maç öncesi barem. Henüz toplanmıyor.

Maç ortasında başlanmışsa önceki dakikalar `null` kalır; geriye dönük veri uydurulmaz.

## 3. Modeller

Tüm modeller aynı arayüzü kullanır: `fit(df)` ve `predict(df) → (ortalama, standart sapma)`. %80 tahmin aralığı `ortalama ± 1.28·sd` ile kurulur.

### 3.1 Referans kurallar

- **`naive_pace`**: `T̂ = S_t · 40/t`. Mevcut uygulamadaki ×40 mantığı. Bitmiş 3. periyotta (t=30) PDF'teki "1-2-3 (YENİ)" formülüne eşittir.
- **`pdf_kriter1`**: `T̂ = Q1 + Q2 + 2·Q̂3`. PDF Kriter 1'deki "4. periyot = 3. periyot" varsayımı. Burada `Q̂3`, devam eden 3. periyodun 10 dakikaya projeksiyonu.
- **`pdf_q2q3x2`**: `T̂ = 2·(Q2 + Q̂3)`.

### 3.2 Empirical Bayes tempo modeli (`empirical_bayes`)

**Model.** Dakika başı sayı, maçın gerçek temposu λ ile aşırı dağılımlı bir Poisson süreci olarak ele alınır. Önsel: `λ ~ Gamma(k·μ, k)`. Eşlenik sonsal ortalama (kredibilite formülü):

```
λ̂_t = (S_t + k·μ) / (t + k)  =  w_t · (S_t / t) + (1 − w_t) · μ,     w_t = t / (t + k)
```

- `μ`: önsel tempo. Lig ortalaması ya da, varsa, `barem / 40`.
- `k`: önselin "kaç dakikalık bilgi" değerinde olduğu. Veriden öğrenilir.

Maçın başında tahmin lig ortalamasına yakındır. Zaman geçtikçe maçın kendi temposu ağır basar.

**Kalan sayı ve tahmin:**

```
R̂_t = ρ_t · λ̂_t · (40 − t)          T̂ = S_t + R̂_t
```

`ρ_t`, dakikaya özel bir düzeltme katsayısıdır. Son dakika faullerini, uzatma olasılığını ve çeyrek tempo farklarını veriden öğrenir.

**Belirsizlik** (toplam varyans yasası):

```
Var(R) = φ · [ ρ_t·λ̂_t·r   +   (ρ_t·r)² · λ̂_t/(t + k) ]
             kalan sürenin       λ'nın kendisine dair
             rastlantısallığı    belirsizlik
```

`φ` aşırı dağılım katsayısıdır. Sayılar 1/2/3'lük paketler hâlinde geldiği için `φ > 1` olur; değeri veriden ölçülür.

**Neden ana model bu?**
- Yalnızca 3 parametre öğrenir (μ, k, φ) ve ρ_t katsayılarını; az veriyle stabil çalışır.
- Açıklanabilir: her parametrenin basketbol karşılığı var.
- Kalibre edilmiş bir tahmin aralığı verir.
- Parametreleri canlı uygulamada birkaç satır JavaScript ile hesaplanabilir.

### 3.3 Öğrenen modeller (veri biriktikçe)

- **`ridge`**: Her dakika için ayrı bir Ridge regresyonu. Hedef kalan tempo `R/r`. Özellikler: tempo, son 5 ve 10 dakikanın temposu, Q1, Q2, `Q̂3`, skor farkı ve EB'nin `λ̂` değeri. Yani Ridge yalnızca EB'nin kaçırdığını öğrenir. Bir dakikada yeterli örnek yoksa o dakika için EB'ye düşer.
- **`gbm`**: Gradient boosting. Tüm dakikalar tek modelde, `t` bir özellik. Ancak ≥ ~1000 maçta anlamlı.

## 4. Doğrulama

- **Zaman sıralı genişleyen pencere.** Model her zaman geçmiş maçlarla eğitilip gelecek maçlarda test edilir; canlı kullanımın aynısı. Rastgele bölme kullanılmaz, çünkü aynı dönemin lig temposunu sızdırır.
- **Metrikler:**
  - MAE (ortalama mutlak hata, puan)
  - RMSE
  - bias (sistematik sapma)
  - `cov80`: %80 aralığın gerçek kapsama oranı; ≈0.80 olmalı
  - `within5`: |hata| ≤ 5 olan maçların oranı

## 5. "3. periyodun hangi dakikası?" — tahmin dakikası seçimi

**Önemli gözlem.** Hata `t` ile neredeyse monoton azalır. Kalan sürenin belirsizliği yaklaşık `√r` ile orantılıdır. Dolayısıyla "en düşük hata" tek başına cevap değildir; her zaman en geç dakikayı seçer. Asıl soru bir ödünleşimdir: erken tahmin (barem henüz iyiyken pozisyon alabilmek) ile doğruluk arasında. Bunu cevaplayan üç ilkeli kriter:

1. **Eşdeğerlik (non-inferiority).** Aynı maçlar üzerinde eşli bootstrap uygulanır. `D_t = MAE(t) − MAE(30)` ve `t* = min { t : D_t'nin %95 üst güven sınırı ≤ δ }`. Yani hatası, en geç dakikadan δ puandan fazla kötü olmadığı istatistiksel olarak gösterilebilen en erken dakika. δ sizin kabul ettiğiniz pay, örneğin 1 puan.
2. **Fayda.** `t* = argmin_t MAE(t) + λ·(t − 21)`. Burada λ bir dakika beklemenin puan cinsinden maliyeti, örneğin barem kayması. λ belirlendiğinde cevap kesinleşir. Gerçek canlı barem verisi toplanırsa λ da veriden ölçülebilir.
3. **Ardışık durma kuralı (maça özel).** Her maçta, tahmin standart sapması `σ̂_t ≤ σ*` olduğu ilk dakikada tahmin sabitlenir. Öngörülebilir maçlarda erken, belirsiz maçlarda geç tahmin yapılır.

Gerçek maçlarda belirli bir dakikadan sonra hatanın düzleştiği bir eşik varsa, kriter 1 onu bulur. Saf bir tempo sürecinde böyle bir eşik yoktur. Sentetik veride (bkz. §7) kriter 1, δ=1 ile 30. dakikayı seçti.

## 6. PDF kriterleri: test edilebilir hipotezler

**Kriter 1:** "Q2 > Q1 ise Q4 ≥ Q3 (%95)". `python -m basketml kriter1` şunları ölçer:

- `P(Q4 ≥ Q3 | Q2 > Q1)`, Wilson %95 güven aralığıyla. Aralığın üst sınırı 0.95'in altında kalırsa iddia veriyle reddedilir.
- `P(Q4 ≥ Q3 | Q2 ≤ Q1)` ve Fisher testi: koşulun gerçekten bir bilgi taşıyıp taşımadığı.
- `P(MS > Q1+Q2+2·Q3 | Q2 > Q1)`: kuralın pratik karşılığı, yani "bu tabanın altındaki baremde Üst" pozisyonunun tutma oranı.

Bu test yalnızca çeyrek skoru gerektirdiği için geçmiş maçlarla hemen yapılabilir.

Not: Mevcut uygulamadaki "Düzenli Düşüş" kuralı (Q1 > Q2 ⇒ Q3 > Q4) bunun ters yöndeki eşidir. Aynı test ikisini birlikte sınar.

**Kriter 2:** "4. periyodun 3-6. dakikalarındaki beklenen sayıdan toplamı bulmak". Bu, EB modelinin dakikaya özel `ρ_t` profiliyle `t = 32..36` aralığında tahmin yapmasının özel bir hâli. `evaluate --minutes 21-36` çıktısı 3. periyot ile 4. periyodun başını doğrudan karşılaştırır.

## 7. Kaç maç lazım?

Sentetik öğrenme eğrisi (`python -m basketml learning-curve`). 1500 maçlık sabit bir test kümesinde, her boyut için 5 tekrar:

| Eğitim maçı | EB MAE @25. dk | Ridge MAE @25. dk | EB MAE @30. dk | Ridge MAE @30. dk |
|---|---|---|---|---|
| 25 | 13.14 ± 0.49 | 13.14 ± 0.49 | 10.81 ± 0.86 | 10.81 ± 0.86 |
| 50 | 12.79 ± 0.07 | 12.91 ± 0.08 | 10.41 ± 0.11 | 10.42 ± 0.23 |
| 100 | 12.83 | 12.92 | 10.36 | 10.31 |
| 200 | 12.72 | 12.70 | 10.31 | 10.17 |
| 400 | 12.74 | 12.69 | 10.33 | 10.15 |
| 800 | 12.73 | 12.67 | 10.31 | 10.12 |

25 maçta Ridge her dakikada EB'ye düşüyor; iki sütunun aynı çıkması bundan.

**Okuma:**
- EB, 50-100 maçta doygunluğa ulaşıyor.
- Ridge EB'yi ancak ~200 maçtan sonra geçiyor.
- Dakika seçimindeki eşli bootstrap testinin güven aralığı ~230 maçta ±0.5-1 puan genişliğinde.

**Öneri:**

| Hedef | Gereken maç sayısı |
|---|---|
| EB parametreleri | ≥ 100 tam izlenmiş bitmiş maç |
| Güvenilir bir dakika seçimi | ≥ 200-300 tam izlenmiş bitmiş maç |
| Ridge | ≥ 400 tam izlenmiş bitmiş maç |
| Gradient boosting | ≥ 1000 tam izlenmiş bitmiş maç |

Gerçek maçlar sentetik veriden daha karmaşıktır; bu sayılar alt sınır olarak okunmalı.

> **Sentetik verinin sınırı.** Üreteç (`basketml/simulate.py`) yalnızca boru hattını test etmek ve örneklem büyüklüğünü kabaca kestirmek içindir. Sentetik veride bir kuralın tutması ya da tutmaması gerçek maçlar hakkında hiçbir şey söylemez. Modellerin gerçek başarısı yalnızca kayıtlı gerçek maçlarla ölçülür.

## 8. Kullanım

```bash
cd ml
python -m venv ../.venv && ../.venv/bin/pip install -r requirements.txt
../.venv/bin/python -m pytest                                        # 18 test
../.venv/bin/python -m basketml evaluate --data ../data/matches      # gerçek kayıtlar
../.venv/bin/python -m basketml evaluate --synthetic 400             # boru hattı denemesi
../.venv/bin/python -m basketml kriter1  --data ../data/matches
../.venv/bin/python -m basketml export   --data ../data/matches      # artifacts/model.json
```

## 9. Sonraki adımlar

1. **Veri toplama altyapısı:** canlı maçları otomatik bulup paralel kaydeden bir toplayıcı ve kalıcı depolama.
2. **Geçmiş veri:** çeyrek skorları ve maç öncesi baremi geçmiş maçlardan toplamak. Bununla Kriter 1 hemen test edilebilir ve EB'nin önseli güçlenir (sentetik testte barem önseli erken dakika hatasını düşürüyor).
3. **Canlı entegrasyon:** `export` çıktısı Node'da okunur, yeni tahmin arayüzü bunun üzerine kurulur.
