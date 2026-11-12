"""3. periyodun hangi dakikasında tahmin yapılmalı?

Hata t ile (neredeyse) monoton azalır: daha geç = daha az belirsizlik. Bu yüzden "en düşük
hata" tek başına cevap değildir — hep en geç dakikayı seçer. Soru aslında bir ödünleşimdir:
erken tahmin (pozisyon almak için zaman/iyi barem) ↔ doğruluk. Üç ilkeli kriter:

1) Eşdeğerlik (non-inferiority): hatası, referans dakikanın (pencerenin sonu) hatasından
   δ puandan FAZLA kötü OLMADIĞI istatistiksel olarak gösterilebilen EN ERKEN dakika.
   Aynı maçlar üzerinde eşli bootstrap: D_t = MAE(t) − MAE(t_ref);  t* = min{t : üst %95 GA(D_t) ≤ δ}.

2) Fayda: t* = argmin_t  MAE(t) + λ·(t − t_0).  λ = bir dakika beklemenin "puan" cinsinden
   maliyeti (örn. barem kayması). λ verildiğinde kesin cevap.

3) Ardışık durma kuralı (maça özel): her maçta tahmin standart sapması σ̂_t ≤ σ* olduğu ilk
   dakikada dur. Tempolu/öngörülebilir maçlarda erken, belirsiz maçlarda geç tahmin yapılır.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def error_matrix(oos: pd.DataFrame, model: str, minutes: list[int]) -> tuple[np.ndarray, list[int]]:
    """Seçili dakikaların HEPSİNDE tahmini olan maçlar × dakika mutlak hata matrisi (eşli karşılaştırma)."""
    sub = oos[(oos["model"] == model) & (oos["t"].isin(minutes))]
    piv = sub.assign(ae=(sub["pred"] - sub["y"]).abs()).pivot_table(
        index="match_id", columns="t", values="ae")
    piv = piv.reindex(columns=minutes).dropna()
    return piv.to_numpy(), list(piv.columns)


def noninferiority(E: np.ndarray, minutes: list[int], delta: float = 1.0,
                   ref: int | None = None, n_boot: int = 2000, alpha: float = 0.05,
                   seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ref_idx = minutes.index(ref) if ref is not None else len(minutes) - 1
    n = E.shape[0]
    D = E - E[:, [ref_idx]]                    # maç başına hata farkı
    boots = rng.integers(0, n, size=(n_boot, n))
    boot_means = D[boots].mean(axis=1)         # (n_boot, T)
    hi = np.quantile(boot_means, 1 - alpha, axis=0)   # tek yönlü üst sınır
    return pd.DataFrame({
        "t": minutes, "MAE": E.mean(axis=0), "diff_vs_ref": D.mean(axis=0),
        "diff_upper95": hi, "noninferior": hi <= delta,
    })


def earliest_noninferior(table: pd.DataFrame) -> int | None:
    ok = table[table["noninferior"]]
    return int(ok["t"].min()) if len(ok) else None


def utility_choice(table: pd.DataFrame, lam: float, t0: int | None = None) -> int:
    t0 = t0 if t0 is not None else int(table["t"].min())
    score = table["MAE"] + lam * (table["t"] - t0)
    return int(table.loc[score.idxmin(), "t"])


def sequential_rule(oos: pd.DataFrame, model: str, minutes: list[int], sd_target: float) -> pd.DataFrame:
    """Her maçta σ̂_t ≤ sd_target olan ilk dakikada (yoksa son dakikada) tahmini sabitle."""
    sub = oos[(oos["model"] == model) & (oos["t"].isin(minutes))].sort_values(["match_id", "t"])
    rows = []
    for mid, g in sub.groupby("match_id"):
        hit = g[g["sd"] <= sd_target]
        row = hit.iloc[0] if len(hit) else g.iloc[-1]
        rows.append({"match_id": mid, "t": int(row["t"]), "abs_err": abs(row["pred"] - row["y"])})
    return pd.DataFrame(rows)
