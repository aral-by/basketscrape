"""Sentetik maç üreteci — Node kayıt modülüyle AYNI JSON şemasında.

Amaç: gerçek veri birikmeden önce (1) tüm boru hattını uçtan uca test etmek, (2) "kaç maç
lazım?" sorusunu öğrenme eğrisiyle cevaplamak. Üreteçteki parametreler FIBA (4×10 dk)
maçları için makul büyüklüklerdir ama GERÇEK DEĞİLDİR: sentetik veride Kriter 1 gibi
desenlerin doğru/yanlış çıkması gerçek maçlar hakkında hiçbir şey söylemez.

Üretim süreci:
  maç temposu   λ_i = μ_lig/40 · exp(N(0, σ_maç))         (maçtan maça tempo farkı)
  dakika temposu λ_i,m = λ_i · q(çeyrek) · exp(d_m),  d_m AR(1) — maç içi tempo kayması
  son dakikalar: fark ≤ 6 ise faul taktiği (×1.35), fark ≥ 20 ise rahatlama (×0.9)
  sayılar: olay sayısı ~ Poisson(λ_i,m / 2.05), her olay 1/2/3 sayı (0.15/0.60/0.25)
  40. dk sonunda eşitlik → 5 dakikalık uzatma(lar)
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

LEAGUES = {"Lig A": 160.0, "Lig B": 168.0, "Lig C": 176.0}
QUARTER_FACTOR = [1.02, 0.99, 0.98, 1.02]
POINT_VALUES = np.array([1, 2, 3])
POINT_PROBS = np.array([0.15, 0.60, 0.25])
MEAN_POINTS = float(POINT_VALUES @ POINT_PROBS)


def _minute_points(rng, rate, home_share):
    n = rng.poisson(rate / MEAN_POINTS)
    pts = rng.choice(POINT_VALUES, size=n, p=POINT_PROBS)
    home = rng.random(n) < home_share
    return int(pts[home].sum()), int(pts[~home].sum())


def simulate_match(rng: np.random.Generator, idx: int, partial_prob: float = 0.0,
                   with_line: bool = False, game_sd: float = 0.08, drift_sd: float = 0.10,
                   drift_ar: float = 0.85) -> dict:
    league = rng.choice(list(LEAGUES))
    mu = LEAGUES[league]
    lam = mu / 40 * np.exp(rng.normal(0, game_sd))
    home_share = float(np.clip(rng.normal(0.5, 0.03), 0.4, 0.6))

    h = a = 0
    cum_h, cum_a = [], []
    d = 0.0
    minute = 0
    while True:
        minute += 1
        if minute <= 40:
            q = (minute - 1) // 10
            factor = QUARTER_FACTOR[q]
        else:
            factor = 1.0
        d = drift_ar * d + rng.normal(0, drift_sd)
        rate = lam * factor * np.exp(d)
        late = minute in (38, 39, 40) or (minute > 40 and (minute - 40) % 5 in (4, 0))
        margin = abs(h - a)
        if late and margin <= 6:
            rate *= 1.35
        elif minute > 30 and margin >= 20:
            rate *= 0.9
        ph, pa = _minute_points(rng, rate, home_share)
        h += ph; a += pa
        cum_h.append(h); cum_a.append(a)
        if minute >= 40 and (minute - 40) % 5 == 0 and h != a:
            break
        if minute > 70:  # güvenlik
            break

    first = 1
    if rng.random() < partial_prob:
        first = int(rng.integers(2, 26))
    obs_h = [None] * (first - 1) + cum_h[first - 1:]
    obs_a = [None] * (first - 1) + cum_a[first - 1:]

    rec = {
        "schema": 1,
        "id": f"sim{idx:06d}",
        "url": f"https://www.flashscore.com/match/sim/?mid=sim{idx:06d}",
        "league": league,
        "homeName": "Ev", "awayName": "Deplasman",
        "recordedAt": f"2026-01-01T00:00:00Z#{idx:06d}",
        "status": "finished",
        "firstObservedMinute": first,
        "cumulative": {"home": obs_h, "away": obs_a},
        "final": {"home": h, "away": a},
    }
    if with_line:
        # Piyasa beklenen toplamı iyi ama kusursuz olmayan biçimde bilir.
        rec["pregameLine"] = round(lam * 40 + rng.normal(0, 4)) + 0.5
    return rec


def simulate(n: int, seed: int = 0, **kw) -> list[dict]:
    rng = np.random.default_rng(seed)
    return [simulate_match(rng, i, **kw) for i in range(n)]


def write_records(records: list[dict], directory: str | Path) -> None:
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    for r in records:
        (d / f"2026-01-01_{r['id']}.json").write_text(json.dumps(r), encoding="utf-8")
