import gzip
import json

from basketml.data import load_matches
from basketml.euroleague import convert_game


def header(**kw):
    h = {"Live": False, "TeamA": "HOME", "TeamB": "AWAY", "Date": "05/10/2023", "Hour": "19:00 ",
         "Competition": "EUROLEAGUE 2023-24", "Phase": "REGULAR SEASON",
         "ScoreA": "12", "ScoreB": "10",
         "ScoreQuarter1A": 3, "ScoreQuarter1B": 2, "ScoreQuarter2A": 6, "ScoreQuarter2B": 4,
         "ScoreQuarter3A": 9, "ScoreQuarter3B": 7, "ScoreQuarter4A": 12, "ScoreQuarter4B": 10}
    h.update(kw)
    return h


def ev(minute, a, b, play="2FGM"):
    return {"MINUTE": minute, "POINTS_A": a, "POINTS_B": b, "PLAYTYPE": play}


def pbp(extra_time=None, **quarters):
    base = {
        "FirstQuarter": [ev(1, None, None, "BP"), ev(2, 3, 0), ev(9, 3, 2)],
        "SecondQuarter": [ev(15, 6, 2), ev(20, 6, 4)],
        "ThirdQuarter": [ev(25, 9, 4), ev(30, 9, 7)],
        "ForthQuarter": [ev(33, 12, 7), ev(40, 12, 10)],
        "ExtraTime": extra_time or [],
        "Live": False,
    }
    base.update(quarters)
    return base


def test_convert_builds_end_of_minute_cumulative_and_metadata():
    r = convert_game("E2023", 7, header(), pbp())
    assert r.reason == "ok"
    rec = r.record
    home = rec["cumulative"]["home"]
    assert len(home) == 40
    assert home[0] == 0 and home[1] == 3 and home[8] == 3      # no event → score unchanged
    assert home[14] == 6 and home[39] == 12
    assert rec["final"] == {"home": 12, "away": 10}
    assert rec["recordedAt"] == "2023-10-05T19:00:00Z"
    assert rec["id"] == "E2023-007" and rec["firstObservedMinute"] == 1


def test_events_with_one_missing_score_are_ignored():
    p = pbp()
    p["FirstQuarter"].append(ev(5, 99, None))
    assert convert_game("E2023", 1, header(), p).reason == "ok"


def test_quarter_mismatch_is_rejected():
    r = convert_game("E2023", 1, header(ScoreQuarter2A=7), pbp())
    assert r.record is None and r.reason == "quarter_mismatch"


def test_final_mismatch_is_rejected():
    r = convert_game("E2023", 1, header(ScoreA="14", ScoreQuarter4A=None), pbp())
    assert r.record is None and r.reason == "final_mismatch"


def test_overtime_expands_in_five_minute_blocks():
    h = header(ScoreA="16", ScoreB="14", ScoreQuarter4A=12, ScoreQuarter4B=12)
    p = pbp(ForthQuarter=[ev(33, 12, 7), ev(40, 12, 12)],
            extra_time=[ev(42, 14, 12), ev(45, 16, 14)])
    rec = convert_game("E2023", 1, h, p).record
    assert rec["overtimePeriods"] == 1 and len(rec["cumulative"]["home"]) == 45
    assert rec["regulation"] == {"home": 12, "away": 12}


def test_unplayed_and_live_games_are_skipped():
    assert convert_game("E2026", 1, header(ScoreA="", ScoreB=""), pbp()).reason == "not_played"
    assert convert_game("E2026", 1, header(Live=True), pbp()).reason == "live"
    assert convert_game("E2026", 1, None, pbp()).reason == "missing"


def test_jsonl_gz_backfill_is_loaded_with_live_recordings(tmp_path):
    rec = convert_game("E2023", 1, header(), pbp()).record
    (tmp_path / "bf").mkdir()
    with gzip.open(tmp_path / "bf" / "E2023.jsonl.gz", "wt") as f:
        f.write(json.dumps(rec) + "\n")
    live = dict(rec, id="live1", recordedAt="2024-01-01T00:00:00Z")
    (tmp_path / "live1.json").write_text(json.dumps(live))
    ms = load_matches(tmp_path)
    assert [m.id for m in ms] == ["E2023-001", "live1"]
    assert ms[0].final_total == 22


def test_fetcher_survives_connection_resets(monkeypatch):
    import io
    import basketml.euroleague as el
    calls = {"n": 0}

    def flaky(req, timeout):
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionResetError(104, "Connection reset by peer")
        return io.BytesIO(b'{"TeamA": "X"}')

    monkeypatch.setattr(el.urllib.request, "urlopen", flaky)
    monkeypatch.setattr(el.time, "sleep", lambda s: None)
    assert el.Fetcher(delay=0, retries=4).get("Header", "E2023", 1) == {"TeamA": "X"}
    assert calls["n"] == 3


def test_fetcher_gives_up_after_retries(monkeypatch):
    import basketml.euroleague as el

    def down(req, timeout):
        raise ConnectionResetError(104, "reset")

    monkeypatch.setattr(el.urllib.request, "urlopen", down)
    monkeypatch.setattr(el.time, "sleep", lambda s: None)
    assert el.Fetcher(delay=0, retries=3).get("Header", "E2023", 1) is None
