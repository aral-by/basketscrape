# Basketbol İstatistik Formülleri

## 1. Four Factors (Dean Oliver)

### eFG% — Etkili Şut Yüzdesi
```
eFG% = (FGM + 0.5 × 3PM) / FGA
```
Ağırlık: **0.40**

### TOV% — Top Kaybı Oranı
```
TOV% = TOV / (FGA + 0.44 × FTA + TOV)
```
Ağırlık: **0.25** *(düşük olan avantajlı)*

### ORB% — Hücum Ribaunt Oranı
```
ORB% = ORB / (ORB + opp_DRB)
```
Ağırlık: **0.20**

### FTR — Serbest Atış Oranı
```
FTR = FTA / FGA
```
Ağırlık: **0.15**

### Four Factors Ağırlıklı Skor
```
fourScore = eFG% × 0.40
          + (1 - TOV%) × 0.25
          + ORB% × 0.20
          + FTR × 0.15
```

---

## 2. Possession Bazlı Verimlilik

### Possession Tahmini
```
poss ≈ FGA − ORB + TOV + 0.44 × FTA
```

### Offensive Rating
```
OffRtg = 100 × (pts / poss)
```

### Defensive Rating
```
DefRtg = 100 × (opp_pts / opp_poss)
```

### Net Rating
```
NetRtg = OffRtg − DefRtg
```

---

## 3. Puan Hesabı
```
pts = (fg2m × 2) + (fg3m × 3) + ftm
```

---

## Chart.js Görselleştirme Türleri

| Görsel | Chart.js Türü | Gösterilen Veri |
|--------|--------------|-----------------|
| Four Factors karşılaştırması | `radar` | eFG%, TOV%, ORB%, FTR — iki takım üst üste |
| OffRtg / DefRtg / NetRtg | `bar` | Her iki takım yan yana, 3 metrik |
| Şut türü dağılımı | `bar` (stacked) | 2'lik / 3'lük / SA — isabet + ıskalama katmanlı |
| Anlık momentum (zaman serisi) | `line` | Dakika bazlı skor değişim hızı (dScore/dt) |
| Possession dominance | `doughnut` | Toplam possession payı |
| Win probability | `line` | Dakika bazlı kazanma olasılığı (lojistik regresyon çıktısı) |