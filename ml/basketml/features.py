"""Dakika t'deki özellikler. KURAL: t anındaki satır yalnızca 1..t dakikalarının verisini kullanır.

Gösterim:
  S_t  : t. dakika sonundaki toplam kümülatif skor (iki takım)
  r    : kalan normal süre = 40 - t
  y    : maç sonu toplam (uzatmalar dahil, MS)
  R_t  : y - S_t, kalan sayı (modellerin asıl tahmin ettiği şey)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import QUARTER_MINUTES, REGULATION_MINUTES
from .data import Match

FEATURE_COLUMNS = [
    "S", "pace", "last5", "last10", "q1", "q2", "q3_sofar", "q3_proj", "margin",
]


def features_at(m: Match, t: int) -> dict:
    S = m.at(t)
    nan = float("nan")

    def window(w: int) -> float:
        return (S - m.at(t - w)) / w if t >= w else nan

    q1 = m.at(10)
    q2 = m.at(20) - m.at(10) if t >= 20 else nan
    q3_sofar = S - m.at(20) if 20 < t <= 30 else (m.at(30) - m.at(20) if t > 30 else nan)
    # PDF'teki "dakika kısmı": devam eden 3. periyodun tamamına projeksiyonu
    q3_proj = q3_sofar * QUARTER_MINUTES / (t - 20) if 20 < t < 30 else q3_sofar

    return {
        "t": t,
        "r": REGULATION_MINUTES - t,
        "S": S,
        "pace": S / t,
        "last5": window(5),
        "last10": window(10),
        "q1": q1,
        "q2": q2,
        "q3_sofar": q3_sofar,
        "q3_proj": q3_proj,
        "margin": abs(m.at(t, "home") - m.at(t, "away")),
        "line": m.pregame_line if m.pregame_line is not None else nan,
    }


def build_dataset(matches: list[Match], minutes: list[int]) -> pd.DataFrame:
    """Her (maç, dakika) için bir satır. Maçlar verilen sırada `order` alır (zaman sırası)."""
    rows = []
    for order, m in enumerate(matches):
        y = m.final_total
        for t in minutes:
            if t > len(m.cum_total) or np.isnan(m.at(t)):
                continue  # o dakika gözlenmemiş (maç ortası başlangıç)
            f = features_at(m, t)
            f.update(match_id=m.id, order=order, league=m.league, y=y, R=y - f["S"])
            rows.append(f)
    return pd.DataFrame(rows)
