"""Dakika t'deki özellikler. KURAL: t anındaki satır yalnızca 1..t dakikalarının verisini kullanır.

Gösterim:
  S_t  : t. dakika sonundaki toplam kümülatif skor (iki takım)
  r    : kalan normal süre = 40 - t
  y    : maç sonu toplam (uzatmalar dahil, MS)
  R_t  : y - S_t, kalan sayı (modellerin asıl tahmin ettiği şey)
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from . import QUARTER_MINUTES, REGULATION_MINUTES
from .data import Match

FEATURE_COLUMNS = [
    "S", "pace", "last5", "last10", "q1", "q2", "q3_sofar", "q3_proj", "margin",
]


def league_key(name: str | None) -> str:
    """Normalises a competition name from any source to a stable key:
    "EUROLEAGUE 2023-24" (API) → "euroleague"; "BasketballEuropeEuroleague - Round 11"
    (live breadcrumb) → "basketballeuropeeuroleague". Models match keys by suffix, so both
    resolve to the same league (see models.EmpiricalBayesPace._league_mu)."""
    if not name:
        return ""
    head = str(name).split(" - ")[0]
    head = re.sub(r"\d{4}(-\d{2,4})?", "", head)
    return re.sub(r"[^a-z]", "", head.lower())


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
    """Her (maç, dakika) için bir satır. Maçlar verilen sırada `order` alır (zaman sırası).

    Ek sütunlar: y_reg (40. dakika toplamı), ot (uzatmaya gitti mi), lg_recent / team_dev
    (yalnızca önceki maçlardan hesaplanan maç öncesi bağlam, bkz. context.py)."""
    from .context import pregame_context
    ctx = pregame_context(matches)
    rows = []
    for order, m in enumerate(matches):
        y = m.final_total
        y_reg = m.regulation_total
        for t in minutes:
            if t > len(m.cum_total) or np.isnan(m.at(t)):
                continue  # o dakika gözlenmemiş (maç ortası başlangıç)
            f = features_at(m, t)
            f.update(match_id=m.id, order=order, league=league_key(m.league), y=y, R=y - f["S"],
                     y_reg=y_reg, ot=bool(np.isfinite(y_reg) and y > y_reg), **ctx[m.id])
            rows.append(f)
    return pd.DataFrame(rows)
