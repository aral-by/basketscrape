# BasketScrape

A real-time basketball analytics web app that scrapes live Flashscore match data via Puppeteer, tracks scores minute by minute, and provides in-depth statistical analysis through an interactive sidebar dashboard.

---

## Features

- Paste any Flashscore live match URL to start tracking
- Scrapes match data every 2 seconds in the background
- Scores recorded minute by minute into period × minute tables
- Mid-match start protection — first cell stays zero, baseline is set on arrival
- Charts update live: per-minute scoring, tempo, and combined view
- Warning banner shown when a match has no Flashscore statistics
- **Exit Match** button stops the scraper and returns to the home screen

---

## Setup

```bash
npm install
npm start
```

Open in browser: `http://localhost:3010`

### Multi-Instance Setup

To run multiple instances simultaneously on different ports:

```
kurulum.bat
```

Creates `basketscrape-3020`, `basketscrape-3030`, `basketscrape-3040`, `basketscrape-3050` folders, each with its own port-configured `start.bat`.

---

## Tests

```bash
npm test
```

Runs the `node:test` suite: score engine, text parsers, URL allow-list and the watcher lifecycle
(against a fake Puppeteer, so no browser or network is needed).

---

## Usage

1. Paste a Flashscore match URL on the home page
2. Click **Start**
3. Once the match begins, `analysis.html` updates automatically
4. Navigate between analysis tabs using the left sidebar
5. To switch matches, click **Exit Match** at the bottom of the sidebar

---

## Project Structure

```
basketscrape/
├── src/
│   ├── server.js        # Express + Socket.IO server, /start and /stop endpoints
│   ├── scraper.js       # Puppeteer-based Flashscore scraper (watcher lifecycle)
│   ├── parse.js         # Pure text parsers + match URL allow-list
│   └── gameState.js     # Minute-by-minute score calculation engine
├── test/                # node:test suite (no browser or network needed)
├── public/
│   ├── index.html       # Match URL input page
│   ├── app.js           # index.html socket handler
│   ├── analysis.html    # Main analysis page (collapsible sidebar + 9 tabs)
│   └── analysis.js      # Table, chart, and metric rendering logic
├── kurulum.bat          # Multi-port setup script (3020/3030/3040/3050)
└── nixpacks.toml        # Railway.app deployment config
```

---

## Analysis Tabs

### Score Tables
Period × Minute format table for each team:

| | 1 | 2 | 3 | ... | 10 |
|---|---|---|---|---|---|
| Q1 | 3 | 0 | 5 | ... | |
| Q2 | | | | | |

- **Raw table:** points scored in that exact minute
- **×40 table:** minute value × 40 (normalized tempo)
- **Combined table:** (home + away) × 40
- **EG10 table:** in-period pace projection — `(period cumulative up to minute m) × (40 / m)`, rounded up only when the fraction is ≥ 0.7

### Charts
- Per-minute home vs away line chart
- Total scoring tempo chart
- **Combined chart:** both teams + total on a single canvas

### Four Factors (Dean Oliver)

| Metric | Formula | Meaning |
|--------|---------|---------|
| eFG% | `(FGM + 0.5 × 3PM) / FGA` | Shooting efficiency weighted for 3-pointers |
| TOV% | `TOV / (FGA + 0.44×FTA + TOV)` | Turnover rate — lower is better |
| ORB% | `ORB / (ORB + opp_DRB)` | Offensive rebound capture rate |
| FTR  | `FTA / FGA` | Free throw generation rate |

### Efficiency

| Metric | Formula |
|--------|---------|
| OffRtg | `100 × (pts / avgPoss)` |
| DefRtg | Opponent's OffRtg |
| NetRtg | `OffRtg − DefRtg` |
| TS%    | `pts / (2 × (FGA + 0.44 × FTA))` |

### Shot Chart
2-pointer / 3-pointer / Free Throw — stacked bar chart showing makes and misses per team.

### Possession
Estimated possessions per team: `FGA − ORB + TOV + 0.44 × FTA`

### Statistics
Raw Flashscore statistics tab data displayed as a formatted table.

### Heat Map
Period × Minute canvas-based heat map — one per team, color intensity only (no numbers).

### Parameters
Quarter tempo bars, the "Regular Decline" pattern check and score-only heuristic predictions
(halftime projection after minute 20, Q3 early projection after minute 25).

> The current prediction engine is a set of hand-written heuristics, not a trained model, and its
> confidence percentages are not calibrated probabilities. It is scheduled to be replaced by a
> data-driven model.

---

## How the Algorithm Works

The core challenge: Flashscore broadcasts **cumulative** scores, not per-minute deltas. The algorithm converts them in real time.

```
scoreboard at minute 7 = 54
scoreboard at minute 6 = 49
→ minute 7 scored = 54 − 49 = 5 points
```

**Key behaviors:**

- **Mid-match start protection** — if the scraper connects at Q4 minute 5 with score 66–75, that update becomes the baseline. The cell stays at 0. No retroactive data is fabricated.
- **Same-minute overwrites** — multiple scrapes within one minute overwrite the cell (not add). The last snapshot before minute change is used.
- **Skipped minutes** — if a minute is missed due to timing, it is filled with 0.
- **Overtime** — the 40-cell array expands by 5 cells per overtime period (OT1 = minutes 41–45, OT2 = 46–50, …).
- **Score corrections** — if Flashscore lowers a score by ≤ 3 points (e.g. a 3 changed to a 2), the difference is removed from that team's most recent cells. Larger drops are treated as scrape errors and the reading is ignored.
- **Time never goes backwards** — a reading with an earlier minute than the last one is ignored.

Full algorithm documentation: [`docs/algo.md`](docs/algo.md)

---

## Technical Notes

**Score calculation** (`gameState.js`): Flashscore broadcasts cumulative scores. `lastHomeSeen` / `lastAwaySeen` baseline tracking is used to derive per-minute deltas. When a scraper starts mid-match, the first update sets the baseline and the cell stays at zero — no retroactive data is assumed.

**Stat name resolution** (`computeMetrics`): Flashscore stat labels vary by match type and language. `findStat` tries Turkish/English keyword variants. "Alan Golü" = total FG (not 2P only) — `resolveFg()` auto-detects and separates 2P from total FG to prevent double-counting in eFG%.

**Watcher lifecycle** (`scraper.js`): `startWatcher()` returns `{ stop }` immediately; waiting for kick-off and the main loop run in the background, so a match can be cancelled before it starts. If Chromium crashes or 5 reads fail in a row, the browser is relaunched and the collected minute data is kept. If nothing changes on the page for 2 minutes, it is reloaded. Before kick-off the page is polled every 10 seconds.

**Server** (`server.js`): only Flashscore URLs are accepted (`/start` rejects anything else with 400). The last status/score snapshot is replayed to newly connected browser tabs.

**Puppeteer on cloud:** If `PUPPETEER_EXECUTABLE_PATH` env variable is set, system Chromium is used; otherwise Puppeteer uses its bundled Chrome.

---

## Tech Stack

| Package | Version | Usage |
|---------|---------|-------|
| express | ^5.2 | HTTP server, static file serving |
| socket.io | ^4.8 | Real-time bidirectional data transfer |
| puppeteer | ^24 | Headless Chrome for Flashscore scraping |
| chart.js | 4.4.2 (CDN) | Line, radar, bar, doughnut charts |
