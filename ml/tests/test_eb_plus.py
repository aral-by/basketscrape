"""EmpiricalBayesPlus (overtime mixture, trend + team prior, calibrated intervals) and the
leak-free pre-game context it relies on."""
import numpy as np
import pandas as pd
import pytest

from basketml.context import pregame_context
from basketml.data import match_from_record
from basketml.evaluate import out_of_sample, summarize
from basketml.features import build_dataset
from basketml.models import EmpiricalBayesPace, EmpiricalBayesPlus

TEAMS = [f"T{i}" for i in range(12)]


def ot_records(n=700, seed=0):
    """Poisson scoring with team-specific tempo, a rising league trend, and real overtimes
    (5-minute periods while the score is level)."""
    rng = np.random.default_rng(seed)
    tempo = dict(zip(TEAMS, rng.normal(0, 0.35, len(TEAMS))))
    recs = []
    for i in range(n):
        h, a = rng.choice(TEAMS, 2, replace=False)
        lam = rng.gamma(60, (3.9 + 0.4 * i / n + tempo[h] + tempo[a]) / 60)   # pts/min, both teams
        home, away, sh, sa = [], [], 0, 0
        minute = 0
        while minute < 40 or (sh == sa and minute < 55):
            minute += 1
            sh += rng.poisson(lam / 2)
            sa += rng.poisson(lam / 2)
            home.append(int(sh))
            away.append(int(sa))
        day = pd.Timestamp("2022-01-01") + pd.Timedelta(days=i // 4)
        recs.append({"schema": 1, "id": f"g{i:04d}", "recordedAt": day.strftime("%Y-%m-%dT20:00:00Z"),
                     "status": "finished", "league": "TESTLEAGUE", "homeName": h, "awayName": a,
                     "cumulative": {"home": home, "away": away}, "final": {"home": sh, "away": sa}})
    return recs


@pytest.fixture(scope="module")
def ot_matches():
    return [match_from_record(r) for r in ot_records()]


def test_dataset_has_regulation_target_and_overtime_flag(ot_matches):
    df = build_dataset(ot_matches, [30]).set_index("match_id")
    for m in ot_matches[:200]:
        row = df.loc[m.id]
        assert row["y_reg"] == m.regulation_total
        assert row["ot"] == (len(m.cum_home) > 40)
    assert df["ot"].any()


def test_pregame_context_uses_only_earlier_matches(ot_matches):
    before = pregame_context(ot_matches)
    k = 300
    changed = list(ot_matches)
    m = changed[k]
    changed[k] = type(m)(**{**m.__dict__, "cum_home": m.cum_home + 40, "final_home": m.final_home + 40})
    after = pregame_context(changed)
    same_or_earlier = [x.id for x in ot_matches if x.recorded_at <= m.recorded_at]
    for mid in same_or_earlier:                       # its own and same-slot games never see it
        assert before[mid] == pytest.approx(after[mid], nan_ok=True)
    later = [x.id for x in ot_matches if x.recorded_at > m.recorded_at]
    assert any(before[mid]["lg_recent"] != after[mid]["lg_recent"] for mid in later)


def test_team_dev_finds_high_and_low_scoring_teams():
    recs = ot_records(n=700, seed=1)
    ms = [match_from_record(r) for r in recs]
    ctx = pregame_context(ms)
    late = [m for m in ms[-200:]]
    dev = np.array([ctx[m.id]["team_dev"] for m in late])
    resid = np.array([m.regulation_total - ctx[m.id]["lg_recent"] for m in late])
    assert np.corrcoef(dev, resid)[0, 1] > 0.2


def test_eb_plus_removes_overtime_bias_and_calibrates_intervals(ot_matches):
    df = build_dataset(ot_matches, [24, 28, 32])
    oos = out_of_sample(df, {"eb": EmpiricalBayesPace, "plus": EmpiricalBayesPlus})
    s = summarize(oos).groupby("model")[["MAE", "bias", "cov80"]].mean()
    # the synthetic league keeps getting faster; the recent-mean prior lags it less
    assert abs(s.loc["plus", "bias"]) < abs(s.loc["eb", "bias"]) and abs(s.loc["plus", "bias"]) < 1.0
    assert s.loc["plus", "MAE"] <= s.loc["eb", "MAE"] + 0.05
    assert 0.75 <= s.loc["plus", "cov80"] <= 0.85


def test_overtime_probability_falls_with_margin(ot_matches):
    model = EmpiricalBayesPlus().fit(build_dataset(ot_matches, [28, 32, 36]))
    probe = build_dataset(ot_matches[:1], [36]).loc[[0, 0, 0]].reset_index(drop=True)
    probe["margin"] = [0, 6, 20]
    p = model.p_overtime(probe)
    assert p[0] > p[1] > p[2] and p[2] < 0.01 and p[0] < 0.6


def test_prob_over_is_a_valid_decreasing_probability(ot_matches):
    model = EmpiricalBayesPlus().fit(build_dataset(ot_matches, [28]))
    row = build_dataset(ot_matches[-1:], [28])
    lines = np.arange(100, 260, 5.0)
    p = np.array([model.prob_over(row, L)[0] for L in lines])
    assert ((p >= 0) & (p <= 1)).all() and (np.diff(p) <= 1e-12).all()
    mean, _ = model.predict(row)
    # overtime tail makes the distribution right-skewed: P(total > mean) < 0.5
    assert model.prob_over(row, mean)[0] < 0.5
