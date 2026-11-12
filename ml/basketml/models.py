"""MS toplam skor modelleri. Hepsi aynı arayüzü uygular:

    fit(train_df)          — train_df: features.build_dataset çıktısı (y ve R sütunları dahil)
    predict(df) -> (mean, sd)   — her satır için MS toplam tahmini ve tahmin standart sapması

Tahmin aralığı normal yaklaşımla kurulur: mean ± z·sd.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression, RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import REGULATION_MINUTES

Z80 = 1.2815515655446004   # standard normal 90th percentile → central 80 % interval


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

    MIN_LEAGUE_MATCHES = 30

    def _league_mu(self, key: str) -> float:
        """League prior: exact key, else a known key that the given key ends with
        (live breadcrumb "basketballeuropeeuroleague" → "euroleague"), else global."""
        if key in self.league_mu_:
            return self.league_mu_[key]
        for k, v in self.league_mu_.items():
            if k and key.endswith(k):
                return v
        return self.mu_

    def _prior(self, df):
        line = df["line"].to_numpy(dtype=float)
        if "league" in df and self.league_mu_:
            cache = {k: self._league_mu(k) for k in df["league"].fillna("").unique()}
            mu = df["league"].fillna("").map(cache).to_numpy(dtype=float, copy=True)
        else:
            mu = np.full(len(df), self.mu_)
        has = ~np.isnan(line)
        mu[has] = line[has] / REGULATION_MINUTES * self.line_scale_
        return mu

    def _lam(self, df, k):
        return (df["S"].to_numpy() + k * self._prior(df)) / (df["t"].to_numpy() + k)

    def fit(self, df: pd.DataFrame):
        per_match = df.drop_duplicates("match_id")
        self.mu_ = float(per_match["y"].mean() / REGULATION_MINUTES)
        self.league_mu_ = {}
        if "league" in per_match:
            for key, g in per_match.groupby(per_match["league"].fillna("")):
                if key and len(g) >= self.MIN_LEAGUE_MATCHES:
                    self.league_mu_[key] = float(g["y"].mean() / REGULATION_MINUTES)
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
        return {"mu_per_min": self.mu_, "league_mu_per_min": self.league_mu_,
                "k": float(self.k_), "phi": self.phi_,
                "line_scale": self.line_scale_, "rho": self.rho_.tolist()}


class EmpiricalBayesPlus(EmpiricalBayesPace):
    """Empirical Bayes pace model + three corrections found on the EuroLeague/EuroCup data:

    1. Overtime is modelled separately. The pace model predicts the REGULATION total
       (40 minutes); overtime is a mixture component on top:
           T̂ = S_t + R̂_reg + p_OT · E[OT points]
           Var = Var_reg + p_OT · Var[OT points] + p_OT(1 − p_OT) · E[OT points]²
       p_OT = logistic(z, z²), z = |margin| / sd(remaining margin) — close games go to OT
       far more often (7.4 % at ≤2 points after minute 28 vs 0.8 % at 13+).
       Without this the pace variance φ absorbs OT outliers and every interval is too wide.
    2. Scoring trend: the prior is driven by the recent league mean (lg_recent, EWMA of
       earlier matches) instead of the all-time mean.
    3. Team tendency: team_dev (both teams' shrunk deviation from the league mean in their
       earlier games) shifts the prior.
           prior total = b0 + b1 · lg_recent + b2 · team_dev     (OLS on training matches)
    A pregame line, when available, still overrides the prior.
    """
    name = "eb_plus"
    MIN_PRIOR_MATCHES = 30

    def fit(self, df: pd.DataFrame):
        d = df[np.isfinite(df["y_reg"].to_numpy(dtype=float))].reset_index(drop=True)
        pm = d.drop_duplicates("match_id")

        extra = (pm["y"] - pm["y_reg"])[pm["ot"].astype(bool)]
        self.ot_mean_ = float(extra.mean()) if len(extra) >= 5 else 25.0
        self.ot_var_ = float(extra.var(ddof=1)) if len(extra) >= 5 else 100.0

        ok = np.isfinite(pm["lg_recent"].to_numpy(dtype=float))
        self.beta_ = None
        if ok.sum() >= self.MIN_PRIOR_MATCHES:
            A = self._prior_design(pm[ok])
            self.beta_ = np.linalg.lstsq(A, pm["y_reg"].to_numpy(dtype=float)[ok], rcond=None)[0]

        reg = d.assign(y=d["y_reg"], R=d["y_reg"] - d["S"])
        super().fit(reg)

        y_ot = d["ot"].astype(bool).to_numpy()
        self.ot_model_ = None
        if 0 < y_ot.sum() < len(y_ot):
            self.ot_model_ = LogisticRegression(C=1.0).fit(self._ot_X(d), y_ot)
        self.ot_rate_ = float(y_ot.mean()) if len(y_ot) else 0.0

        # Interval calibration: score totals have a sharper peak and heavier tails than a
        # normal, so mean ± 1.28·sd covered ~85 % instead of 80 %. Rescale sd so that the
        # 80 % interval is exact on the training matches (one parameter, per minute).
        self.sd_scale_, self.reg_scale_ = {}, {}
        m_reg, s_reg = EmpiricalBayesPace.predict(self, d)
        z_reg = np.abs(d["y_reg"].to_numpy(dtype=float) - m_reg) / s_reg
        not_ot = ~y_ot
        mean, sd = self._predict_raw(d)
        zs = np.abs(d["y"].to_numpy(dtype=float) - mean) / sd
        for t, idx in d.groupby("t").indices.items():
            if len(idx) >= 50:
                self.sd_scale_[int(t)] = float(np.quantile(zs[idx], 0.8) / Z80)
                self.reg_scale_[int(t)] = float(np.quantile(z_reg[idx][not_ot[idx]], 0.8) / Z80)
        return self

    def prob_over(self, df: pd.DataFrame, line) -> np.ndarray:
        """P(final total > line) from the two-component mixture
        (no overtime: N(m_reg, c·sd_reg); overtime: N(m_reg + E_ot, c·√(sd_reg² + Var_ot)))."""
        from scipy.stats import norm
        line = np.broadcast_to(np.asarray(line, dtype=float), (len(df),))
        m_reg, s_reg = EmpiricalBayesPace.predict(self, df)
        c = _lookup_sd(self.reg_scale_, df["t"].to_numpy()) if self.reg_scale_ else 1.0
        p = self.p_overtime(df)
        over_reg = norm.sf(line, m_reg, c * s_reg)
        over_ot = norm.sf(line, m_reg + self.ot_mean_, c * np.sqrt(s_reg ** 2 + self.ot_var_))
        return (1 - p) * over_reg + p * over_ot

    @staticmethod
    def _prior_design(df):
        lg = df["lg_recent"].to_numpy(dtype=float)
        team = np.nan_to_num(df["team_dev"].to_numpy(dtype=float))
        return np.column_stack([np.ones(len(df)), lg, team])

    def _prior(self, df):
        mu = super()._prior(df)
        if getattr(self, "beta_", None) is None or "lg_recent" not in df:
            return mu
        use = np.isfinite(df["lg_recent"].to_numpy(dtype=float)) & np.isnan(df["line"].to_numpy(dtype=float))
        if use.any():
            mu[use] = (self._prior_design(df[use]) @ self.beta_) / REGULATION_MINUTES
        return mu

    def _ot_X(self, df):
        ts = df["t"].to_numpy()
        r = df["r"].to_numpy(dtype=float)
        lam = self._lam(df, self.k_)
        sd_margin = np.sqrt(self.phi_ * self.rho_[np.clip(ts, 0, REGULATION_MINUTES)] * lam * r + 1.0)
        z = df["margin"].to_numpy(dtype=float) / sd_margin
        return np.column_stack([z, z ** 2])

    def p_overtime(self, df):
        if self.ot_model_ is None:
            return np.full(len(df), self.ot_rate_)
        return self.ot_model_.predict_proba(self._ot_X(df))[:, 1]

    def _predict_raw(self, df):
        mean_reg, sd_reg = super().predict(df)
        p = self.p_overtime(df)
        mean = mean_reg + p * self.ot_mean_
        var = sd_reg ** 2 + p * self.ot_var_ + p * (1 - p) * self.ot_mean_ ** 2
        return mean, np.sqrt(var)

    def predict(self, df: pd.DataFrame):
        """Returns (mean, sd); sd is scaled so that mean ± 1.2816·sd is a calibrated 80 % interval."""
        mean, sd = self._predict_raw(df)
        if self.sd_scale_:
            sd = sd * _lookup_sd(self.sd_scale_, df["t"].to_numpy())
        return mean, sd

    def params(self) -> dict:
        out = super().params()
        out.update({
            "prior_beta": None if self.beta_ is None else self.beta_.tolist(),
            "sd_scale": self.sd_scale_, "reg_scale": self.reg_scale_, "ot_points_mean": self.ot_mean_, "ot_points_var": self.ot_var_,
            "ot_logit": None if self.ot_model_ is None else {
                "intercept": float(self.ot_model_.intercept_[0]),
                "coef_z_z2": self.ot_model_.coef_[0].tolist()},
        })
        return out


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
    for cls in [NaivePace, PdfKriter1, PdfQ23, EmpiricalBayesPace, EmpiricalBayesPlus,
                RidgePerMinute, GradientBoosting]
}
