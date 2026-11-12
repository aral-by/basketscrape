"""Zaman sıralı (ileriye dönük) doğrulama: model hep GEÇMİŞ maçlarla eğitilip GELECEK
maçlarda test edilir — canlı kullanımın birebir aynısı. Rastgele bölme, aynı dönemdeki
maçların lig temposu bilgisini sızdırır ve iyimser sonuç verir."""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm

Z80 = float(norm.ppf(0.90))   # %80 aralık


def expanding_folds(n_matches: int, n_folds: int = 5, min_train_frac: float = 0.4):
    """[0, a) ile eğit, [a, b) ile test et; a her katmanda büyür."""
    start = max(int(n_matches * min_train_frac), 1)
    edges = np.linspace(start, n_matches, n_folds + 1).astype(int)
    for a, b in zip(edges[:-1], edges[1:]):
        if b > a:
            yield np.arange(0, a), np.arange(a, b)


def out_of_sample(df: pd.DataFrame, model_factories: dict, n_folds: int = 5,
                  min_train_frac: float = 0.4) -> pd.DataFrame:
    """Her model için örneklem dışı tahminler: match_id, order, t, model, pred, sd, y."""
    n = int(df["order"].max()) + 1
    out = []
    for train_idx, test_idx in expanding_folds(n, n_folds, min_train_frac):
        train = df[df["order"].isin(train_idx)].reset_index(drop=True)
        test = df[df["order"].isin(test_idx)].reset_index(drop=True)
        if train.empty or test.empty:
            continue
        for name, factory in model_factories.items():
            model = factory()
            model.fit(train)
            pred, sd = model.predict(test)
            out.append(pd.DataFrame({
                "match_id": test["match_id"], "order": test["order"], "t": test["t"],
                "model": name, "pred": pred, "sd": sd, "y": test["y"],
            }))
    res = pd.concat(out, ignore_index=True)
    return res[np.isfinite(res["pred"])]


def summarize(oos: pd.DataFrame) -> pd.DataFrame:
    """Model × dakika başına hata metrikleri."""
    e = oos["pred"] - oos["y"]
    oos = oos.assign(err=e, abs_err=e.abs(),
                     covered=(e.abs() <= Z80 * oos["sd"]),
                     within5=(e.abs() <= 5))
    g = oos.groupby(["model", "t"])
    return pd.DataFrame({
        "n": g.size(),
        "MAE": g["abs_err"].mean(),
        "RMSE": g["err"].apply(lambda x: float(np.sqrt(np.mean(x ** 2)))),
        "bias": g["err"].mean(),
        "cov80": g["covered"].mean(),
        "within5": g["within5"].mean(),
        "sd_mean": g["sd"].mean(),
    }).reset_index()
