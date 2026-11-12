"""MS toplam skor modelleri. Hepsi aynı arayüzü uygular:

    fit(train_df)          — train_df: features.build_dataset çıktısı (y ve R sütunları dahil)
    predict(df) -> (mean, sd)   — her satır için MS toplam tahmini ve tahmin standart sapması

Tahmin aralığı normal yaklaşımla kurulur: mean ± z·sd.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import REGULATION_MINUTES


def _residual_sd_by_t(df: pd.DataFrame, pred: np.ndarray, n_params: int = 0) -> dict[int, float]:
    """Her dakika için eğitim artıklarının standart sapması (küçük örneklem için şişirilmiş)."""
    out = {}
    resid = df["y"].to_numpy() - pred
    for t, idx in df.groupby("t").indices.items():
        r_t = resid[idx]
        r_t = r_t[np.isfinite(r_t)]
        n = len(r_t)
        if n < 3:
            continue
        sd = float(np.std(r_t, ddof=1))
        out[int(t)] = sd * np.sqrt(1 + (n_params + 1) / n)
    return out


def _lookup_sd(sd_by_t: dict[int, float], ts: np.ndarray) -> np.ndarray:
    keys = np.array(sorted(sd_by_t))
    vals = np.array([sd_by_t[k] for k in keys])
    return np.interp(ts, keys, vals)


class _ResidualSdMixin:
    """Ortalama tahmini kendi kuralından gelen, belirsizliği eğitim artıklarından ölçülen modeller."""
    n_params = 0

    def fit(self, df: pd.DataFrame):
        self.sd_by_t_ = _residual_sd_by_t(df, self._mean(df), self.n_params)
        return self

    def predict(self, df: pd.DataFrame):
        mean = self._mean(df)
        return mean, _lookup_sd(self.sd_by_t_, df["t"].to_numpy())


# ── Referans (naif) kurallar ─────────────────────────────────────────────────

class NaivePace(_ResidualSdMixin):
    """T̂ = S_t × 40 / t — mevcut uygulamadaki ×40 mantığı (uzatma ve tempo değişimi yok)."""
    name = "naive_pace"

    def _mean(self, df):
        return df["S"].to_numpy() * REGULATION_MINUTES / df["t"].to_numpy()


class PdfKriter1(_ResidualSdMixin):
    """PDF Kriter 1: 4. periyot = (projekte) 3. periyot varsayımı.
    T̂ = Q1 + Q2 + 2·Q3̂, Q3̂ = devam eden 3. periyodun 10 dakikaya projeksiyonu.
    Yalnızca 3. periyot başladıktan sonra (t > 20) tanımlı."""
    name = "pdf_kriter1"

    def _mean(self, df):
        return (df["q1"] + df["q2"] + 2 * df["q3_proj"]).to_numpy()


class PdfQ23(_ResidualSdMixin):
    """PDF '2 ve 3. periyotların muhtemel MS': (Q2 + Q3̂) × 2."""
    name = "pdf_q2q3x2"

    def _mean(self, df):
        return (2 * (df["q2"] + df["q3_proj"])).to_numpy()


# ── Empirical Bayes (Gamma–Poisson) tempo modeli ─────────────────────────────

class EmpiricalBayesPace:
    """Kalan sayıyı, maçın 'gerçek temposu' λ'nın sonsal ortalamasıyla tahmin eder.

    Model: dakika başı sayı ~ (aşırı dağılımlı) Poisson(λ), önsel λ ~ Gamma(k·μ, k).
    Gözlem: t dakikada S_t sayı. Eşlenik sonsal ortalama (kredibilite formülü):

        λ̂_t = (S_t + k·μ) / (t + k)        μ: önsel tempo (lig ortalaması veya barem/40)
                                             k: önselin ağırlığı ("kaç dakikalık bilgi" değerinde)
    t küçükken λ̂ ≈ μ (lig ortalaması), t büyüdükçe λ̂ → S_t/t (maçın kendi temposu).

        R̂_t = ρ_t · λ̂_t · (40 − t)          ρ_t: kalan sürenin tempo düzeltmesi (son dakika
                                             faulleri, uzatma olasılığı) — veriden öğrenilir
        T̂   = S_t + R̂_t

    Belirsizlik (toplam varyans yasası):
        Var(R) = φ · ρ_t·λ̂_t·r  [kalan sürenin rastlantısallığı, r = 40 − t]
               + φ · (ρ_t·r)² · λ̂_t / (t + k)   [λ'nın kendisine dair belirsizlik]
    φ: aşırı dağılım katsayısı (sayılar 1/2/3'lük paketler hâlinde gelir → φ > 1), veriden.
    """
    name = "empirical_bayes"

    def __init__(self, k_grid=None):
        self.k_grid = k_grid if k_grid is not None else np.geomspace(0.5, 400, 60)

    def _prior(self, df):
        line = df["line"].to_numpy(dtype=float)
        mu = np.full(len(df), self.mu_)
        has = ~np.isnan(line)
        mu[has] = line[has] / REGULATION_MINUTES * self.line_scale_
        return mu

    def _lam(self, df, k):
        return (df["S"].to_numpy() + k * self._prior(df)) / (df["t"].to_numpy() + k)

    def fit(self, df: pd.DataFrame):
        per_match = df.drop_duplicates("match_id")
        self.mu_ = float(per_match["y"].mean() / REGULATION_MINUTES)
        lines = per_match["line"].to_numpy(dtype=float)
        has = ~np.isnan(lines)
        # Barem sistematik olarak yüksek/düşükse ölçekle (barem ≈ beklenen toplam olmalı)
        self.line_scale_ = float(per_match["y"][has].sum() / lines[has].sum()) if has.sum() >= 10 else 1.0

        r = df["r"].to_numpy(dtype=float)
        R = df["R"].to_numpy(dtype=float)
        ts = df["t"].to_numpy()

        best = None
        for k in self.k_grid:
            lam = self._lam(df, k)
            rho = self._fit_rho(ts, R, lam * r)
            err = np.mean(np.abs(R - rho[ts] * lam * r))
            if best is None or err < best[0]:
                best = (err, k, rho)
        _, self.k_, self.rho_ = best

        lam = self._lam(df, self.k_)
        mean_R = self.rho_[ts] * lam * r
        base = self._var_base(lam, r, ts)
        resid2 = (R - mean_R) ** 2
        self.phi_ = float(resid2.sum() / base.sum())
        return self

    @staticmethod
    def _fit_rho(ts, R, expected):
        """ρ_t = Σ R / Σ (λ̂·r) her dakika için (oranların oranı, uç değerlere dayanıklı)."""
        rho = np.ones(REGULATION_MINUTES + 1)
        for t in np.unique(ts):
            mask = ts == t
            denom = expected[mask].sum()
            if denom > 0:
                rho[t] = R[mask].sum() / denom
        return rho

    def _var_base(self, lam, r, ts):
        rho = self.rho_[ts]
        return rho * lam * r + (rho * r) ** 2 * lam / (ts + self.k_)

    def predict(self, df: pd.DataFrame):
        ts = df["t"].to_numpy()
        r = df["r"].to_numpy(dtype=float)
        lam = self._lam(df, self.k_)
        mean = df["S"].to_numpy() + self.rho_[np.clip(ts, 0, REGULATION_MINUTES)] * lam * r
        sd = np.sqrt(self.phi_ * self._var_base(lam, r, ts))
        return mean, sd

    def params(self) -> dict:
        return {"mu_per_min": self.mu_, "k": float(self.k_), "phi": self.phi_,
                "line_scale": self.line_scale_, "rho": self.rho_.tolist()}


# ── Öğrenen modeller ─────────────────────────────────────────────────────────

RIDGE_FEATURES = ["pace", "last5", "last10", "q1", "q2", "q3_proj", "margin", "eb_lambda"]


class RidgePerMinute:
    """Her dakika için ayrı Ridge regresyonu; hedef kalan tempo R/r.
    EB'nin λ̂'sı bir özellik olarak verilir → Ridge yalnızca EB'nin kaçırdığını öğrenir.
    Bir dakikada yeterli örnek yoksa (min_rows) o dakika için EB'ye düşer."""
    name = "ridge"

    def __init__(self, min_rows: int = 40):
        self.min_rows = min_rows

    def _X(self, df):
        X = df.copy()
        X["eb_lambda"] = self.eb_._lam(df, self.eb_.k_)
        return X[RIDGE_FEATURES]

    def fit(self, df: pd.DataFrame):
        self.eb_ = EmpiricalBayesPace().fit(df)
        self.models_ = {}
        X_all = self._X(df)
        for t, idx in df.groupby("t").indices.items():
            X = X_all.iloc[idx]
            ok = ~X.isna().any(axis=1).to_numpy()
            if ok.sum() < self.min_rows:
                continue
            sub = df.iloc[idx][ok]
            y = (sub["R"] / sub["r"]).to_numpy()
            model = make_pipeline(StandardScaler(), RidgeCV(alphas=np.geomspace(0.1, 1000, 25)))
            model.fit(X[ok], y)
            pred_T = sub["S"].to_numpy() + model.predict(X[ok]) * sub["r"].to_numpy()
            resid = sub["y"].to_numpy() - pred_T
            n = len(sub)
            sd = float(np.std(resid, ddof=1) * np.sqrt(1 + (len(RIDGE_FEATURES) + 1) / n))
            self.models_[int(t)] = (model, sd)
        return self

    def predict(self, df: pd.DataFrame):
        mean, sd = self.eb_.predict(df)
        mean, sd = mean.copy(), sd.copy()
        X_all = self._X(df)
        for t, idx in df.groupby("t").indices.items():
            if int(t) not in self.models_:
                continue
            model, s = self.models_[int(t)]
            X = X_all.iloc[idx]
            ok = ~X.isna().any(axis=1).to_numpy()
            rows = idx[ok]
            if len(rows):
                sub = df.iloc[rows]
                mean[rows] = sub["S"].to_numpy() + model.predict(X.iloc[np.where(ok)[0]]) * sub["r"].to_numpy()
                sd[rows] = s
        return mean, sd


class GradientBoosting:
    """Tüm dakikalar tek modelde (t bir özellik). Ancak çok veri olduğunda anlamlıdır
    (bkz. docs/ml-design.md: ≥ ~1000 maç). Eksik özellikleri kendisi ele alır."""
    name = "gbm"

    def fit(self, df: pd.DataFrame):
        self.eb_ = EmpiricalBayesPace().fit(df)
        X = self._X(df)
        y = (df["R"] / df["r"]).to_numpy()
        self.model_ = HistGradientBoostingRegressor(
            max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40,
            l2_regularization=1.0, random_state=0,
        ).fit(X, y)
        mean = df["S"].to_numpy() + self.model_.predict(X) * df["r"].to_numpy()
        self.sd_by_t_ = _residual_sd_by_t(df, mean, n_params=20)
        return self

    def _X(self, df):
        X = df[["t"] + RIDGE_FEATURES[:-1]].copy()
        X["eb_lambda"] = self.eb_._lam(df, self.eb_.k_)
        return X

    def predict(self, df: pd.DataFrame):
        mean = df["S"].to_numpy() + self.model_.predict(self._X(df)) * df["r"].to_numpy()
        return mean, _lookup_sd(self.sd_by_t_, df["t"].to_numpy())


MODEL_REGISTRY = {
    cls.name: cls
    for cls in [NaivePace, PdfKriter1, PdfQ23, EmpiricalBayesPace, RidgePerMinute, GradientBoosting]
}
