"""Komut satırı:

  python -m basketml evaluate --data ../data/matches          gerçek kayıtlarla değerlendirme
  python -m basketml evaluate --synthetic 400                 sentetik veriyle (boru hattı testi)
  python -m basketml kriter1 --data ../data/matches           PDF Kriter 1 hipotez testi
  python -m basketml learning-curve                           "kaç maç lazım?" (sentetik)
  python -m basketml export --data ../data/matches            canlı uygulama için model parametreleri
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import timing
from .analysis import kriter1_test, learning_curve
from .data import load_matches, match_from_record
from .evaluate import out_of_sample, summarize
from .features import build_dataset
from .models import MODEL_REGISTRY, EmpiricalBayesPlus
from .simulate import simulate

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 20)


def _minutes(spec: str) -> list[int]:
    a, b = spec.split("-")
    return list(range(int(a), int(b) + 1))


def _load(args):
    if args.synthetic:
        recs = simulate(args.synthetic, seed=args.seed, partial_prob=0.2, with_line=args.with_line)
        return [m for m in (match_from_record(r) for r in recs) if m]
    if not args.data:
        sys.exit("--data veya --synthetic gerekli")
    return load_matches(args.data)


def cmd_evaluate(args):
    matches = _load(args)
    minutes = _minutes(args.minutes)
    print(f"{len(matches)} bitmiş maç, dakikalar {minutes[0]}-{minutes[-1]}")
    if len(matches) < 30:
        print("UYARI: 30'dan az maç — sonuçlar güvenilir değil (bkz. docs/ml-design.md).")
    df = build_dataset(matches, minutes)
    models = {k: v for k, v in MODEL_REGISTRY.items() if k in args.models.split(",")}
    oos = out_of_sample(df, models)
    s = summarize(oos)
    print("\nÖrneklem dışı MAE (puan) — model × dakika:")
    print(s.pivot(index="t", columns="model", values="MAE").round(2))
    print("\n%80 tahmin aralığının gerçek kapsama oranı (0.80 olmalı):")
    print(s.pivot(index="t", columns="model", values="cov80").round(2))

    q3 = [t for t in minutes if 21 <= t <= 30]
    if q3:
        E, cols = timing.error_matrix(oos, args.timing_model, q3)
        if len(E) >= 20:
            tab = timing.noninferiority(E, cols, delta=args.delta)
            print(f"\nTahmin dakikası seçimi ({args.timing_model}, eşli n={len(E)} maç, δ={args.delta}):")
            print(tab.round(2).to_string(index=False))
            print(f"  Eşdeğerlik kriteri  → en erken dakika: {timing.earliest_noninferior(tab)}")
            for lam in (0.25, 0.5, 1.0):
                print(f"  Fayda kriteri λ={lam:<4} → {timing.utility_choice(tab, lam)}. dakika")
            seq = timing.sequential_rule(oos, args.timing_model, q3, args.sd_target)
            print(f"  Ardışık kural σ̂≤{args.sd_target}: ort. dakika {seq['t'].mean():.1f}, "
                  f"MAE {seq['abs_err'].mean():.2f}")


def cmd_kriter1(args):
    r = kriter1_test(_load(args))
    if not r.get("n"):
        print("Dört çeyreği de gözlenmiş bitmiş maç yok.")
        return
    f = lambda ci: f"[{ci[0]:.2f}, {ci[1]:.2f}]"
    print(f"Dört çeyreği tam {r['n']} maç; Q2 > Q1 olan {r['n_cond']} maç")
    print(f"  P(Q4 ≥ Q3 | Q2 > Q1) = {r['p_cond']:.3f}  %95 GA {f(r['p_cond_ci95'])}   (iddia: {r['claimed']})")
    print(f"  P(Q4 ≥ Q3 | Q2 ≤ Q1) = {r['p_other']:.3f}  %95 GA {f(r['p_other_ci95'])}")
    print(f"  Genel oran P(Q4 ≥ Q3) = {r['base_rate']:.3f}   Fisher p = {r['fisher_p']:.4f}")
    print(f"  P(MS > Q1+Q2+2·Q3 | Q2 > Q1) = {r['floor_hit']:.3f}  %95 GA {f(r['floor_hit_ci95'])}")
    if r["p_cond_ci95"][1] < r["claimed"]:
        print("  → %95 iddiası veriyle REDDEDİLİYOR (güven aralığının üst sınırı 0.95'in altında).")


def cmd_learning_curve(args):
    minutes = _minutes(args.minutes)
    pool = [match_from_record(r) for r in simulate(max(args.sizes), seed=args.seed)]
    test = [match_from_record(r) for r in simulate(args.test_size, seed=args.seed + 1)]
    lc = learning_curve(pool, test, args.sizes, minutes, reps=args.reps, seed=args.seed)
    t = args.at
    sub = lc[lc["t"] == t]
    tab = sub.groupby(["model", "n_train"])["MAE"].agg(["mean", "std"]).round(2)
    print(f"Sentetik öğrenme eğrisi — {t}. dakikada MAE (test: {args.test_size} maç, {args.reps} tekrar):")
    print(tab.unstack(0))


def cmd_export(args):
    """Model parameters + current league/team context + out-of-sample validation for the
    live app (src/predictor.js). Optionally writes parity cases for the Node test suite."""
    from .context import pregame_context
    matches = _load(args)
    df = build_dataset(matches, list(range(1, 40)))
    eb = EmpiricalBayesPlus().fit(df)
    _, state = pregame_context(matches, return_state=True)

    val = summarize(out_of_sample(build_dataset(matches, list(range(15, 40))),
                                  {"eb_plus": EmpiricalBayesPlus}))
    validation = {int(r.t): {"MAE": round(r.MAE, 3), "cov80": round(r.cov80, 3),
                             "within5": round(r.within5, 3), "n": int(r.n)}
                  for r in val.itertuples()}
    out = {"model": "eb_plus", "schema": 2, "n_matches": len(matches),
           "trained_until": matches[-1].recorded_at if matches else None,
           "leagues_trained": sorted(df["league"].dropna().unique().tolist()),
           "lock_rule": {"from": 21, "to": 30, "sd_target": args.sd_target},
           **eb.params(), "context": state, "validation": validation}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, separators=(",", ":")))
    print(f"{args.out} yazıldı: k={eb.k_:.1f}, μ={eb.mu_ * 40:.1f}/maç, φ={eb.phi_:.2f}")

    if args.parity_out:
        rng = np.random.default_rng(0)
        rows = df.sample(n=min(200, len(df)), random_state=0).reset_index(drop=True)
        rows["line"] = np.nan
        rows.loc[rows.index[:150], "lg_recent"] = rows["lg_recent"][:150]
        rows.loc[rows.index[150:175], ["lg_recent", "team_dev"]] = np.nan   # fallback path
        mean, sd = eb.predict(rows)
        lines = np.round(mean + rng.uniform(-15, 15, len(rows))) + 0.5
        cases = [{"t": int(r.t), "S": float(r.S), "margin": float(r.margin), "league": r.league,
                  "lgRecent": None if np.isnan(r.lg_recent) else float(r.lg_recent),
                  "teamDev": None if np.isnan(r.team_dev) else float(r.team_dev),
                  "line": float(L), "mean": float(m), "sd": float(s),
                  "pOT": float(p), "pOver": float(po)}
                 for r, m, s, L, p, po in zip(rows.itertuples(), mean, sd, lines,
                                               eb.p_overtime(rows), eb.prob_over(rows, lines))]
        Path(args.parity_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.parity_out).write_text(json.dumps(cases, indent=0))
        print(f"{args.parity_out}: {len(cases)} parity cases")


def cmd_backfill(args):
    from .euroleague import Fetcher, backfill_season
    fetcher = Fetcher(delay=args.delay)
    total = 0
    for season in args.seasons:
        if (Path(args.out) / f"{season}.jsonl.gz").exists() and not args.force:
            print(f"{season}: already downloaded, skipping (use --force to refetch)")
            continue
        st = backfill_season(season, Path(args.out), fetcher)
        total += st.kept
    print(f"done: {total} games, {fetcher.requests} requests")


def main(argv=None):
    p = argparse.ArgumentParser(prog="basketml")
    sub = p.add_subparsers(dest="cmd", required=True)

    def data_args(sp):
        sp.add_argument("--data", help="kayıt klasörü (örn. ../data/matches)")
        sp.add_argument("--synthetic", type=int, help="gerçek veri yerine N sentetik maç")
        sp.add_argument("--with-line", action="store_true", help="sentetik maçlara barem ekle")
        sp.add_argument("--seed", type=int, default=0)

    e = sub.add_parser("evaluate"); data_args(e)
    e.add_argument("--minutes", default="21-36")
    e.add_argument("--models", default=",".join(MODEL_REGISTRY))
    e.add_argument("--timing-model", default="eb_plus")
    e.add_argument("--delta", type=float, default=1.0, help="eşdeğerlik payı (puan)")
    e.add_argument("--sd-target", type=float, default=9.5)
    e.set_defaults(fn=cmd_evaluate)

    k = sub.add_parser("kriter1"); data_args(k); k.set_defaults(fn=cmd_kriter1)

    lc = sub.add_parser("learning-curve")
    lc.add_argument("--sizes", type=int, nargs="+", default=[25, 50, 100, 200, 400, 800])
    lc.add_argument("--test-size", type=int, default=1500)
    lc.add_argument("--reps", type=int, default=5)
    lc.add_argument("--minutes", default="21-30")
    lc.add_argument("--at", type=int, default=25)
    lc.add_argument("--seed", type=int, default=0)
    lc.set_defaults(fn=cmd_learning_curve)

    x = sub.add_parser("export"); data_args(x)
    x.add_argument("--out", default="../models/eb_plus.json")
    x.add_argument("--parity-out", help="write Node parity test cases (test/fixtures/...)")
    x.add_argument("--sd-target", type=float, default=9.5, help="lock rule σ* for the live app")
    x.set_defaults(fn=cmd_export)

    b = sub.add_parser("backfill-euroleague", help="EuroLeague/EuroCup minute data from the official API")
    b.add_argument("--seasons", nargs="+", required=True, help="e.g. E2023 U2023 (E=EuroLeague, U=EuroCup)")
    b.add_argument("--out", default="datasets/euroleague")
    b.add_argument("--delay", type=float, default=0.35, help="seconds between requests")
    b.add_argument("--force", action="store_true", help="refetch seasons that already exist")
    b.set_defaults(fn=cmd_backfill)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
