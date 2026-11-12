"""Hipotez testleri ve örneklem büyüklüğü analizi."""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import fisher_exact

from .data import Match
from .evaluate import summarize
from .features import build_dataset
from .models import EmpiricalBayesPace, RidgePerMinute


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return float("nan"), float("nan")
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return c - h, c + h


def kriter1_test(matches: list[Match]) -> dict:
    """PDF Kriter 1: "Q2 > Q1 ise Q4 ≥ Q3 olur (%95)".

    Ölçülenler:
      p_cond  = P(Q4 ≥ Q3 | Q2 > Q1)   — iddia edilen olasılık (%95)
      p_other = P(Q4 ≥ Q3 | Q2 ≤ Q1)   — koşul sağlanmadığında
      Fisher testi: koşul gerçekten bir şey söylüyor mu (p_cond ≠ p_other)?
      floor_hit = P(MS toplam > Q1+Q2+2·Q3 | Q2 > Q1) — kuralın pratik karşılığı:
                  "Q1+Q2+2·Q3'ün altındaki baremde Üst" pozisyonunun tutma oranı.
    """
    rows = []
    for m in matches:
        q = m.quarter_totals()
        if np.isnan(q).any():
            continue
        rows.append({"cond": q[1] > q[0], "q4_ge_q3": q[3] >= q[2],
                     "floor": q[0] + q[1] + 2 * q[2], "y": m.final_total})
    df = pd.DataFrame(rows)
    if df.empty:
        return {"n": 0}
    c, o = df[df["cond"]], df[~df["cond"]]
    k1, n1 = int(c["q4_ge_q3"].sum()), len(c)
    k0, n0 = int(o["q4_ge_q3"].sum()), len(o)
    hit_k = int((c["y"] > c["floor"]).sum())
    _, p_fisher = fisher_exact([[k1, n1 - k1], [k0, n0 - k0]]) if n1 and n0 else (None, float("nan"))
    return {
        "n": len(df),
        "n_cond": n1,
        "p_cond": k1 / n1 if n1 else float("nan"), "p_cond_ci95": wilson(k1, n1),
        "p_other": k0 / n0 if n0 else float("nan"), "p_other_ci95": wilson(k0, n0),
        "base_rate": float(df["q4_ge_q3"].mean()),
        "fisher_p": float(p_fisher),
        "floor_hit": hit_k / n1 if n1 else float("nan"), "floor_hit_ci95": wilson(hit_k, n1),
        "claimed": 0.95,
    }


def learning_curve(train_pool: list[Match], test: list[Match], sizes: list[int],
                   minutes: list[int], reps: int = 5, seed: int = 0) -> pd.DataFrame:
    """Eğitim maçı sayısına göre örneklem dışı MAE. Sabit, büyük bir test kümesinde ölçülür;
    her boyut için eğitim kümesi `reps` kez yeniden örneklenir (sonucun oynaklığı için)."""
    rng = np.random.default_rng(seed)
    test_df = build_dataset(test, minutes)
    out = []
    for n in sizes:
        for rep in range(reps):
            idx = rng.choice(len(train_pool), size=min(n, len(train_pool)), replace=False)
            train_df = build_dataset([train_pool[i] for i in sorted(idx)], minutes)
            for name, cls in [("empirical_bayes", EmpiricalBayesPace), ("ridge", RidgePerMinute)]:
                model = cls().fit(train_df)
                pred, sd = model.predict(test_df)
                oos = pd.DataFrame({"match_id": test_df["match_id"], "t": test_df["t"],
                                    "model": name, "pred": pred, "sd": sd, "y": test_df["y"]})
                s = summarize(oos)
                for _, r in s.iterrows():
                    out.append({"n_train": n, "rep": rep, "model": name, "t": r["t"],
                                "MAE": r["MAE"], "cov80": r["cov80"]})
    return pd.DataFrame(out)
