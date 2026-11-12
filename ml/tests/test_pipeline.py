import json

import numpy as np
import pandas as pd
import pytest

from basketml import timing
from basketml.analysis import kriter1_test, wilson
from basketml.data import load_matches, match_from_record
from basketml.evaluate import expanding_folds, out_of_sample, summarize
from basketml.features import build_dataset, features_at
from basketml.models import (EmpiricalBayesPace, NaivePace, PdfKriter1, RidgePerMinute)
from basketml.simulate import simulate, write_records


def rec(home, away, final=None, status="finished", **kw):
    r = {"schema": 1, "id": kw.pop("id", "m1"), "recordedAt": kw.pop("recordedAt", "2026-01-01"),
         "status": status, "cumulative": {"home": home, "away": away},
         "final": final or {"home": next(v for v in reversed(home) if v is not None),
                            "away": next(v for v in reversed(away) if v is not None)}}
    r.update(kw)
    return r


def linear_match(per_min_home=2, per_min_away=2, n=40, **kw):
    return rec([per_min_home * (i + 1) for i in range(n)], [per_min_away * (i + 1) for i in range(n)], **kw)


@pytest.fixture(scope="module")
def synth():
    return [match_from_record(r) for r in simulate(300, seed=7, partial_prob=0.2)]


# ── Veri yükleme ────────────────────────────────────────────────────────────

def test_only_finished_records_with_final_are_used():
    assert match_from_record(linear_match()) is not None
    assert match_from_record(linear_match(status="stopped")) is None
    bad = linear_match(); bad["final"] = None
    assert match_from_record(bad) is None
    assert match_from_record({**linear_match(), "schema": 99}) is None


def test_forward_fill_never_invents_data_before_first_observation():
    m = match_from_record(rec([None, None, 5, None, 9], [None, None, 4, None, 6]))
    assert np.isnan(m.at(1)) and np.isnan(m.at(2))
    assert m.at(3) == 9 and m.at(4) == 9 and m.at(5) == 15
    assert m.at(0) == 0


def test_load_matches_sorts_chronologically(tmp_path):
    for i, ts in enumerate(["2026-03-01", "2026-01-01", "2026-02-01"]):
        (tmp_path / f"x{i}.json").write_text(json.dumps(linear_match(id=f"m{i}", recordedAt=ts)))
    (tmp_path / "broken.json").write_text("{not json")
    ms = load_matches(tmp_path)
    assert [m.recorded_at for m in ms] == ["2026-01-01", "2026-02-01", "2026-03-01"]


def test_quarter_totals_and_regulation():
    m = match_from_record(linear_match(1, 2))
    assert list(m.quarter_totals()) == [30, 30, 30, 30]
    assert m.regulation_total == 120 and m.final_total == 120


# ── Özellikler: veri sızıntısı yok ──────────────────────────────────────────

def test_features_at_t_do_not_depend_on_future_minutes():
    base = linear_match()
    future_changed = json.loads(json.dumps(base))
    for i in range(25, 40):
        future_changed["cumulative"]["home"][i] += 50
    a = features_at(match_from_record(base), 25)
    b = features_at(match_from_record(future_changed), 25)
    assert a.keys() == b.keys()
    for k in a:
        assert a[k] == b[k] or (np.isnan(a[k]) and np.isnan(b[k])), k


def test_feature_values():
    f = features_at(match_from_record(linear_match()), 25)
    assert f["S"] == 100 and f["pace"] == 4 and f["last5"] == 4 and f["last10"] == 4
    assert f["q1"] == 40 and f["q2"] == 40 and f["q3_sofar"] == 20 and f["q3_proj"] == 40
    assert f["r"] == 15 and f["margin"] == 0


def test_build_dataset_skips_unobserved_minutes():
    m = match_from_record(rec([None] * 22 + list(range(50, 68)), [None] * 22 + list(range(50, 68))))
    df = build_dataset([m], list(range(21, 31)))
    assert df["t"].min() == 23
    assert (df["R"] == df["y"] - df["S"]).all()


# ── Modeller ────────────────────────────────────────────────────────────────

def test_pdf_formulas_match_the_pdf_example():
    # PDF örneği: Q1=25, Q2=32, Q3=20 → "Genel muhtemel" (Q4=Q3) = 97
    per_q = [25, 32, 20, 20]
    cum, s = [], 0
    for q in per_q:
        for i in range(10):
            s += q / 10
            cum.append(s)
    m = match_from_record(rec([c / 2 for c in cum], [c / 2 for c in cum], final={"home": 48.5, "away": 48.5}))
    df = build_dataset([m], [30])
    assert PdfKriter1()._mean(df)[0] == pytest.approx(97)
    assert NaivePace()._mean(df)[0] == pytest.approx((25 + 32 + 20) * 4 / 3)  # "1-2-3 (YENİ)"


def test_empirical_bayes_shrinkage_weight_grows_with_time(synth):
    df = build_dataset(synth, list(range(1, 40)))
    eb = EmpiricalBayesPace().fit(df)
    probe = pd.DataFrame({"S": [30.0, 210.0], "t": [5, 35], "r": [35, 5], "line": [np.nan, np.nan]})
    lam = eb._lam(probe, eb.k_)
    observed = probe["S"] / probe["t"]          # 6.0/dk her iki durumda
    # Tahmin, lig ortalaması ile maçın gözlenen temposu ARASINDA kalır
    assert ((lam > eb.mu_) & (lam < observed)).all()
    # Maçın kendi verisinin ağırlığı w_t = t / (t + k), zamanla artar
    w = (lam - eb.mu_) / (observed - eb.mu_)
    np.testing.assert_allclose(w, probe["t"] / (probe["t"] + eb.k_))
    assert w[1] > w[0]
    assert 0.5 < eb.k_ < 400 and eb.phi_ > 1


def test_eb_beats_naive_and_is_calibrated_out_of_sample(synth):
    df = build_dataset(synth, list(range(21, 31)))
    oos = out_of_sample(df, {"eb": EmpiricalBayesPace, "naive": NaivePace})
    s = summarize(oos).groupby("model")[["MAE", "cov80"]].mean()
    assert s.loc["eb", "MAE"] < s.loc["naive", "MAE"]
    assert 0.72 <= s.loc["eb", "cov80"] <= 0.90


def test_line_prior_improves_early_predictions():
    recs = simulate(300, seed=3, with_line=True)
    with_line = [match_from_record(r) for r in recs]
    no_line = [match_from_record({k: v for k, v in r.items() if k != "pregameLine"}) for r in recs]
    mae = {}
    for name, ms in [("line", with_line), ("none", no_line)]:
        oos = out_of_sample(build_dataset(ms, [5, 10]), {"eb": EmpiricalBayesPace})
        mae[name] = (oos["pred"] - oos["y"]).abs().mean()
    assert mae["line"] < mae["none"]


def test_ridge_falls_back_to_eb_with_too_little_data(synth):
    df = build_dataset(synth[:20], [25])
    r = RidgePerMinute(min_rows=40).fit(df)
    assert r.models_ == {}
    np.testing.assert_allclose(r.predict(df)[0], r.eb_.predict(df)[0])


# ── Doğrulama ve dakika seçimi ──────────────────────────────────────────────

def test_expanding_folds_never_train_on_the_future():
    for train, test in expanding_folds(100, 5):
        assert train.max() < test.min()
        assert train[0] == 0


def test_noninferiority_picks_earliest_equivalent_minute():
    rng = np.random.default_rng(0)
    n = 400
    base = rng.normal(10, 2, size=(n, 1))
    # dk 21-23 belirgin kötü, 24'ten itibaren referansla aynı
    E = np.hstack([base + 3, base + 2, base + 1.5] + [base + rng.normal(0, 0.1, (n, 1)) for _ in range(7)])
    tab = timing.noninferiority(E, list(range(21, 31)), delta=0.5)
    assert timing.earliest_noninferior(tab) == 24


def test_utility_choice_tradeoff():
    tab = pd.DataFrame({"t": [21, 22, 23], "MAE": [12.0, 10.0, 9.8]})
    assert timing.utility_choice(tab, lam=0.0) == 23
    assert timing.utility_choice(tab, lam=0.5) == 22
    assert timing.utility_choice(tab, lam=5.0) == 21


# ── Kriter 1 ────────────────────────────────────────────────────────────────

def test_wilson_interval():
    lo, hi = wilson(95, 100)
    assert 0.88 < lo < 0.90 and 0.97 < hi < 0.99


def test_kriter1_counts(tmp_path):
    def quarters(q):
        cum, s = [], 0
        for v in q:
            for i in range(10):
                s += v / 10
                cum.append(s)
        return match_from_record(rec(cum, [0] * 40, final={"home": s, "away": 0}))
    ms = [quarters([20, 30, 25, 28]),   # Q2>Q1, Q4≥Q3  ✓
          quarters([20, 30, 25, 20]),   # Q2>Q1, Q4<Q3  ✗
          quarters([30, 20, 25, 25])]   # koşul yok
    r = kriter1_test(ms)
    assert r["n"] == 3 and r["n_cond"] == 2
    assert r["p_cond"] == 0.5 and r["p_other"] == 1.0
    assert r["floor_hit"] == 0.5  # 103 > 100 ✓, 95 > 100 ✗


def test_simulated_records_round_trip_through_disk(tmp_path):
    write_records(simulate(5, seed=1), tmp_path)
    ms = load_matches(tmp_path)
    assert len(ms) == 5
    assert all(m.final_total == m.at(len(m.cum_total)) for m in ms)


def test_league_key_normalises_sources():
    from basketml.features import league_key
    assert league_key("EUROLEAGUE 2023-24") == "euroleague"
    assert league_key("EUROCUP 2021-22") == "eurocup"
    assert league_key("BasketballEuropeEuroleague - Round 11") == "basketballeuropeeuroleague"
    assert league_key(None) == ""


def test_league_prior_used_and_matched_by_suffix():
    import numpy as np
    recs = simulate(400, seed=5)
    ms = [match_from_record(r) for r in recs]
    df = build_dataset(ms, [5])
    eb = EmpiricalBayesPace().fit(df)
    assert set(eb.league_mu_) == {"liga", "ligb", "ligc"}
    assert eb.league_mu_["liga"] < eb.league_mu_["ligc"]       # 160 vs 176 in the simulator
    assert eb._league_mu("basketballeuropeligc") == eb.league_mu_["ligc"]
    assert eb._league_mu("unknown") == eb.mu_
