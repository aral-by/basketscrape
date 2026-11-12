# ML Design: Live Full-Time Total Prediction

## 1. Problem

During a live FIBA game (4 × 10 minutes), at absolute minute `t`:

1. **Predict the full-time total** `y`: the combined score of both teams at the final whistle, overtime included, with a calibrated prediction interval.
2. **Choose the third-quarter minute** at which to commit to that prediction, based on measured accuracy.

| Symbol | Meaning |
|---|---|
| `S_t` | Combined cumulative score after minute `t` |
| `r = 40 − t` | Remaining regulation minutes |
| `y` | Full-time total, overtime included |
| `R_t = y − S_t` | Points still to come; this is what every model predicts |

**No look-ahead.** A row for minute `t` uses only minutes `1 … t`. This is enforced by a unit test (`ml/tests/test_pipeline.py`).

> NBA (4 × 12) and NCAA (2 × 20) formats are out of scope. The live scraper also assumes 10-minute quarters.

---

## 2. Pipeline

```mermaid
flowchart LR
    subgraph Collection["Collection (Node)"]
        LIVE["live match"] --> REC["recorder.js"]
        REC --> JSON[("data/matches/*.json")]
    end
    subgraph Training["Training and evaluation (Python, ml/basketml)"]
        JSON --> LOAD["data.py<br/>load finished matches,<br/>chronological order"]
        LOAD --> FEAT["features.py<br/>one row per (match, minute),<br/>no look-ahead"]
        FEAT --> CV["evaluate.py<br/>expanding-window validation"]
        CV --> MET["metrics<br/>MAE · RMSE · bias · coverage"]
        CV --> TIM["timing.py<br/>prediction-minute selection"]
        FEAT --> FIT["fit on all data"]
        FIT --> EXP["export<br/>artifacts/model.json"]
    end
    EXP --> APP["live dashboard<br/>(planned)"]
```

---

## 3. Data

### Sources

| Data | Source | Available for past matches? |
|---|---|---|
| Minute-by-minute cumulative score | Our own live recordings | **No.** Flashscore's point-by-point feed has no timestamps (verified 2026-11). |
| Quarter scores | Flashscore match summary | Yes, for every finished match |
| Pre-game over/under line | Flashscore odds tab | Yes |

Consequently, the **third-quarter minute question can only be answered from our own recordings**. Quarter-level questions, such as the quarter-pattern hypotheses in §7, can be tested on historical data immediately.

### Record format (schema 1)

Written by `src/recorder.js`; the full format is in [`algo.md`](algo.md#5-match-recordings).

- `cumulative.home[i]`, `cumulative.away[i]`: scoreboard at the end of minute `i + 1`, or `null` if not observed.
- `final`: full-time score.
- `firstObservedMinute`: when the scraper joined.
- `pregameLine`: optional, not collected yet.

When loading, a gap after the first observation is forward-filled with the last known score. Minutes before the first observation stay missing: nothing is fabricated.

### Features at minute `t`

| Feature | Definition |
|---|---|
| `S` | `S_t` |
| `pace` | `S_t / t` |
| `last5`, `last10` | `(S_t − S_{t−5}) / 5`, `(S_t − S_{t−10}) / 10` |
| `q1`, `q2` | Combined points in Q1 and Q2 |
| `q3_sofar` | Combined points in Q3 up to `t` |
| `q3_proj` | Q3 projected to 10 minutes: `q3_sofar · 10 / (t − 20)` |
| `margin` | Absolute score difference |
| `line` | Pre-game over/under line, if available |

---

## 4. Models

Every model implements `fit(df)` and `predict(df) → (mean, sd)`. The 80 % prediction interval is `mean ± 1.28 · sd`.

```mermaid
flowchart TB
    subgraph Baselines["Baselines (fixed rules)"]
        N["naive_pace<br/>S_t · 40 / t"]
        K1["pdf_kriter1<br/>Q1 + Q2 + 2·Q̂3"]
        Q23["pdf_q2q3x2<br/>2·(Q2 + Q̂3)"]
    end
    subgraph Core["Core model"]
        EB["empirical_bayes<br/>Gamma–Poisson pace<br/>params: μ, k, φ, ρ_t"]
    end
    subgraph Learned["Learned corrections (need more data)"]
        RG["ridge<br/>per minute, ≥ 40 rows"]
        GB["gbm<br/>pooled, ≥ ~1000 matches"]
    end
    EB -- "λ̂ as a feature" --> RG
    EB -- "λ̂ as a feature" --> GB
    RG -. "too little data:<br/>fall back" .-> EB
```

### 4.1 Baselines

| Model | Prediction | Origin |
|---|---|---|
| `naive_pace` | `S_t · 40 / t` | The ×40 logic of the current dashboard. At `t = 30` it equals the "1-2-3 (new)" calculator formula. |
| `pdf_kriter1` | `Q1 + Q2 + 2·Q̂3` | Criterion 1 from the user's calculator: assume Q4 = Q3. |
| `pdf_q2q3x2` | `2·(Q2 + Q̂3)` | The calculator's "Q2 + Q3" projection. |

`Q̂3` is the in-progress third quarter projected to 10 minutes. For these rules the prediction interval comes from the spread of their training errors at each minute.

### 4.2 Empirical Bayes pace model (`empirical_bayes`)

**Model.** Points per minute follow an over-dispersed Poisson process with match-specific rate `λ`. The prior is `λ ~ Gamma(kμ, k)`. After observing `S_t` points in `t` minutes, the conjugate posterior mean is the credibility formula:

```math
\hat\lambda_t \;=\; \frac{S_t + k\mu}{t + k} \;=\; w_t\,\frac{S_t}{t} + (1 - w_t)\,\mu,
\qquad w_t = \frac{t}{t + k}
```

- `μ` is the prior pace: the league mean, or `line / 40` when a pre-game line exists.
- `k` is the prior strength, measured in minutes of evidence. It is fitted from data.

Early in the game the estimate stays close to the league mean; as `t` grows, the match's own pace dominates.

**Point prediction:**

```math
\hat R_t = \rho_t\,\hat\lambda_t\,(40 - t), \qquad \hat y = S_t + \hat R_t
```

`ρ_t` is a per-minute adjustment learned from data. It captures late-game fouling, the chance of overtime and quarter-to-quarter pace differences.

**Uncertainty**, by the law of total variance:

```math
\operatorname{Var}(R_t) = \varphi \Big[\; \underbrace{\rho_t \hat\lambda_t r}_{\text{randomness of the remaining time}} \;+\; \underbrace{(\rho_t r)^2 \frac{\hat\lambda_t}{t + k}}_{\text{uncertainty about } \lambda} \;\Big]
```

`φ` is the over-dispersion factor. Points arrive in packets of 1, 2 or 3, so `φ > 1`.

**Fitting:**

| Parameter | Estimate |
|---|---|
| `μ` | Mean full-time total of the training matches, divided by 40 |
| `k` | Grid search over 0.5–400 minimising the mean absolute error of `R_t` |
| `ρ_t` | For each minute, the sum of actual remaining points divided by the sum of predicted remaining points |
| `φ` | Sum of squared residuals divided by the sum of the bracketed variance terms |

**Why this is the core model:**

- It has very few parameters and is stable with little data.
- Every parameter has a basketball meaning.
- Its prediction intervals are calibrated (§8).
- It can be evaluated in a few lines of JavaScript in the live app.

### 4.3 Learned models

- **`ridge`**: one ridge regression per minute. The target is the remaining pace `R_t / r`. The features are those in §3 plus the Empirical Bayes estimate `λ̂_t`, so ridge only learns what Empirical Bayes misses. Minutes with fewer than 40 complete training rows fall back to Empirical Bayes.
- **`gbm`**: histogram gradient boosting over all minutes, with `t` as a feature. It is only worthwhile with roughly 1000 or more matches.

---

## 5. Validation

Models are always trained on **earlier** matches and tested on **later** ones, which is exactly how they are used live. Random splits are not used: they would leak league-level pace from the same period into training.

```mermaid
gantt
    title Expanding-window validation (5 folds, first 40 % is training only)
    dateFormat X
    axisFormat %s
    section Fold 1
    train :done, f1tr, 0, 40
    test  :crit, f1te, after f1tr, 52
    section Fold 2
    train :done, f2tr, 0, 52
    test  :crit, f2te, after f2tr, 64
    section Fold 3
    train :done, f3tr, 0, 64
    test  :crit, f3te, after f3tr, 76
    section Fold 4
    train :done, f4tr, 0, 76
    test  :crit, f4te, after f4tr, 88
    section Fold 5
    train :done, f5tr, 0, 88
    test  :crit, f5te, after f5tr, 100
```

The axis is the percentage of matches in chronological order.

| Metric | Meaning | Target |
|---|---|---|
| MAE | Mean absolute error, in points | As low as possible |
| RMSE | Root mean squared error | As low as possible |
| bias | Mean signed error | ≈ 0 |
| `cov80` | Share of matches inside the 80 % interval | ≈ 0.80 |
| `within5` | Share of predictions within 5 points | As high as possible |

---

## 6. Which third-quarter minute?

Error falls almost monotonically with `t`, because the uncertainty about the remaining points scales roughly with `√r`. Minimising error alone therefore always selects the latest minute. The real question is a **trade-off**: predicting earlier, while the line is still favourable, against predicting more accurately. Three principled criteria are implemented in `timing.py`:

```mermaid
flowchart TD
    OOS["out-of-sample errors<br/>e(match, t), t = 21…30"] --> NI
    OOS --> UT
    OOS --> SQ

    NI["1 · Non-inferiority<br/>paired bootstrap of<br/>D_t = MAE(t) − MAE(30)"] --> NIq{"95 % upper bound<br/>of D_t ≤ δ ?"}
    NIq -- "earliest such t" --> T1["t* (statistical)"]

    UT["2 · Utility<br/>MAE(t) + λ·(t − 21)"] --> T2["t* = argmin<br/>(λ = cost of waiting one minute)"]

    SQ["3 · Sequential rule<br/>per match"] --> SQq{"σ̂_t ≤ σ* ?"}
    SQq -- "first such t" --> T3["match-specific minute"]
```

1. **Non-inferiority.** Using a paired bootstrap over matches, select the earliest minute whose error is not more than `δ` points worse than at minute 30, at 95 % confidence:

   ```math
   t^* = \min\left\{\, t \;:\; \mathrm{UCB}_{95\%}\big[\mathrm{MAE}(t) - \mathrm{MAE}(30)\big] \le \delta \,\right\}
   ```

   `δ` is the accuracy you are willing to give up, for example 1 point.

2. **Utility.** With `λ` the cost, in points, of waiting one more minute:

   ```math
   t^* = \arg\min_t \; \mathrm{MAE}(t) + \lambda\,(t - 21)
   ```

   If live line movements are recorded later, `λ` can itself be measured from data.

3. **Sequential stopping.** In each match, fix the prediction at the first minute where its own standard deviation falls below `σ*`. Predictable matches are called early and volatile ones late.

If real matches show a plateau after which error stops improving, criterion 1 finds it. A pure pace process has no such plateau: on synthetic data criterion 1 selected minute 30 with `δ = 1`.

---

## 7. Quarter-pattern hypotheses

### Criterion 1

The claim: *"If Q2 > Q1, then Q4 ≥ Q3 (95 % of the time)."*

`python -m basketml kriter1` measures:

| Quantity | Purpose |
|---|---|
| `P(Q4 ≥ Q3 \| Q2 > Q1)` with a Wilson 95 % interval | The claim itself. If the interval's upper bound is below 0.95, the claim is rejected. |
| `P(Q4 ≥ Q3 \| Q2 ≤ Q1)` and Fisher's exact test | Whether the condition carries any information at all |
| `P(y > Q1 + Q2 + 2·Q3 \| Q2 > Q1)` | The practical rule: how often an *Over* at that floor wins |

The dashboard's existing "Regular Decline" rule (Q1 > Q2 ⇒ Q3 > Q4) is the mirror image, so the same data tests both. This test needs only quarter scores, so it can run on historical matches.

### Criterion 2

The claim: *"Estimate the total from the points expected in minutes 3–6 of Q4."*

This is a special case of the Empirical Bayes model evaluated at `t = 32 … 36` with its per-minute profile `ρ_t`. `evaluate --minutes 21-36` compares the third quarter with the start of the fourth directly.

---

## 8. How many matches are needed?

Synthetic learning curve (`python -m basketml learning-curve`): a fixed test set of 1500 matches, 5 resamples per training size, out-of-sample MAE in points.

| Training matches | EB @ 25 | Ridge @ 25 | EB @ 30 | Ridge @ 30 |
|---|---|---|---|---|
| 25 | 13.14 ± 0.49 | 13.14 ± 0.49 | 10.81 ± 0.86 | 10.81 ± 0.86 |
| 50 | 12.79 ± 0.07 | 12.91 ± 0.08 | 10.41 ± 0.11 | 10.42 ± 0.23 |
| 100 | 12.83 | 12.92 | 10.36 | 10.31 |
| 200 | 12.72 | 12.70 | 10.31 | 10.17 |
| 400 | 12.74 | 12.69 | 10.33 | 10.15 |
| 800 | 12.73 | 12.67 | 10.31 | 10.12 |

At 25 matches ridge falls back to Empirical Bayes at every minute, which is why both columns are identical.

```mermaid
---
config:
  themeVariables:
    xyChart:
      plotColorPalette: "#2563eb, #dc2626"
---
xychart-beta
    title "Synthetic out-of-sample MAE at minute 30"
    x-axis "training matches" [25, 50, 100, 200, 400, 800]
    y-axis "MAE (points)" 9.8 --> 11
    line [10.81, 10.41, 10.36, 10.31, 10.33, 10.31]
    line [10.81, 10.42, 10.31, 10.17, 10.15, 10.12]
```

Blue: Empirical Bayes. Red: ridge.

On the same synthetic data, at minute 21 Empirical Bayes was about 3.7 points more accurate than `naive_pace`, and its 80 % intervals covered 81–89 % of outcomes.

**Reading the curve:**

- Empirical Bayes saturates at 50–100 matches.
- Ridge overtakes it only from about 200 matches.
- With about 230 matches, the bootstrap interval in minute selection is roughly ±0.5–1 point wide.

**Recommendation:**

| Goal | Fully observed finished matches |
|---|---|
| Empirical Bayes parameters | ≥ 100 |
| Reliable prediction-minute selection | ≥ 200–300 |
| Ridge | ≥ 400 |
| Gradient boosting | ≥ 1000 |

Real games have more structure than the simulator, so read these as **lower bounds**.

> **Limits of synthetic data.** The generator (`basketml/simulate.py`) exists to test the pipeline end to end and to size the data requirement. Whether a pattern holds in synthetic data says **nothing** about real matches. Real performance is measured only on recorded real matches.

---

## 9. Usage

```bash
python -m venv .venv && .venv/bin/pip install -r ml/requirements.txt
cd ml
../.venv/bin/python -m pytest                                       # 18 tests
../.venv/bin/python -m basketml evaluate --data ../data/matches     # real recordings
../.venv/bin/python -m basketml evaluate --synthetic 400            # pipeline check
../.venv/bin/python -m basketml kriter1  --data ../data/matches     # Criterion 1 test
../.venv/bin/python -m basketml learning-curve                      # sample-size study
../.venv/bin/python -m basketml export   --data ../data/matches     # artifacts/model.json
```

---

## 10. Roadmap

```mermaid
flowchart LR
    A["1 · Collector<br/>auto-discover live matches,<br/>record in parallel,<br/>persistent storage"] --> C
    B["2 · Historical backfill<br/>quarter scores +<br/>pre-game lines"] --> C
    B --> H["test Criterion 1<br/>on real data"]
    C["3 · Train on<br/>real recordings"] --> D["4 · Live integration<br/>model.json in Node,<br/>new prediction UI"]
```

1. **Collector.** Find live matches in the target leagues automatically, record several at once, and store the recordings persistently.
2. **Historical backfill.** Collect quarter scores and pre-game lines from past matches. This tests Criterion 1 at once and gives Empirical Bayes a stronger prior: on synthetic data the line prior lowers early-minute error.
3. **Live integration.** Load the exported parameters in Node and build the new prediction UI on top of them.
