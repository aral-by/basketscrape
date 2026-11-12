"""Node kayıt modülünün (src/recorder.js) yazdığı JSON maç kayıtlarını okur."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import REGULATION_MINUTES

SCHEMA_VERSION = 1


@dataclass
class Match:
    id: str
    recorded_at: str
    league: str | None
    cum_home: np.ndarray            # mutlak dakika t'nin sonundaki skor, indeks t-1; gözlenmeyen = NaN
    cum_away: np.ndarray
    final_home: float
    final_away: float
    pregame_line: float | None = None   # maç öncesi Alt/Üst baremi (varsa)
    meta: dict = field(default_factory=dict)

    @property
    def cum_total(self) -> np.ndarray:
        return self.cum_home + self.cum_away

    @property
    def final_total(self) -> float:
        return self.final_home + self.final_away

    @property
    def regulation_total(self) -> float:
        """40. dakika sonu toplamı; gözlenmediyse NaN."""
        if len(self.cum_home) < REGULATION_MINUTES:
            return float("nan")
        return float(self.cum_total[REGULATION_MINUTES - 1])

    def quarter_totals(self) -> np.ndarray:
        """4 çeyreğin toplam sayısı (iki takım); bir çeyrek sınırı gözlenmediyse NaN."""
        ends = [self.at(10), self.at(20), self.at(30), self.at(40)]
        starts = [0.0] + ends[:3]
        return np.array([e - s for s, e in zip(starts, ends)], dtype=float)

    def at(self, t: int, side: str = "total") -> float:
        """t. dakika sonundaki kümülatif skor (t=0 → 0)."""
        if t == 0:
            return 0.0
        arr = {"total": self.cum_total, "home": self.cum_home, "away": self.cum_away}[side]
        if t > len(arr):
            return float("nan")
        return float(arr[t - 1])


def _forward_fill_observed(values: list) -> np.ndarray:
    """İlk gözlemden sonraki boş (atlanmış) dakikaları son bilinen skorla doldurur.
    Skor, gözlemlenmeyen bir dakikada değişmediyse doğru; değiştiyse o sayılar bir sonraki
    gözleme kayar (canlı uygulamadaki dakika tablosuyla aynı davranış).
    İlk gözlemden ÖNCEKİ dakikalar NaN kalır — geriye dönük veri uydurulmaz."""
    out = np.full(len(values), np.nan)
    last = np.nan
    for i, v in enumerate(values):
        if v is not None:
            last = float(v)
        out[i] = last
    return out


def match_from_record(rec: dict) -> Match | None:
    """Eğitimde kullanılabilir (bitmiş, maç sonu skoru bilinen) kayıtları Match'e çevirir."""
    if rec.get("schema") != SCHEMA_VERSION or rec.get("status") != "finished":
        return None
    final = rec.get("final") or {}
    if final.get("home") is None or final.get("away") is None:
        return None
    cum = rec.get("cumulative") or {}
    home, away = cum.get("home") or [], cum.get("away") or []
    if not home or len(home) != len(away):
        return None
    return Match(
        id=rec["id"],
        recorded_at=rec.get("recordedAt", ""),
        league=rec.get("league"),
        cum_home=_forward_fill_observed(home),
        cum_away=_forward_fill_observed(away),
        final_home=float(final["home"]),
        final_away=float(final["away"]),
        pregame_line=rec.get("pregameLine"),
        meta={"firstObservedMinute": rec.get("firstObservedMinute")},
    )


def load_matches(directory: str | Path) -> list[Match]:
    """Klasördeki tüm kayıtları okur, kayıt zamanına göre sıralar (zaman sıralı doğrulama için)."""
    matches = []
    for path in sorted(Path(directory).glob("*.json")):
        try:
            rec = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        m = match_from_record(rec)
        if m is not None:
            matches.append(m)
    matches.sort(key=lambda m: (m.recorded_at, m.id))
    return matches
