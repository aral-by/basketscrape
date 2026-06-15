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
│   ├── scraper.js       # Puppeteer-based Flashscore scraper
│   └── gameState.js     # Minute-by-minute score calculation engine
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
Prediction engine tab:

- **Quarter tempo bars:** points scored per Q1/Q2/Q3/Q4 for each team and combined
- **Regular Decline pattern:** if Q1 total > Q2 total, predicts Q3 total > Q4 total
- **Q3 Minute 5 Prediction Engine:** unlocks after absolute minute 25

#### Prediction Formula

```
1. Raw projection   = (cumulative total at Q3 min 5 / 25) × 40
2. Required scoring = projection − cumulative at Q3 min 5
3. Window (Q2 min 5 → Q3 min 5, 10 min) pace vs remaining (15 min) pace
   → Window pace > required pace  ⟹  Over ↑
   → Window pace < required pace  ⟹  Under ↓
4. Regular Decline adjustment (if active): final = projection − (Q1 + Q2 avg) / 4
```

---

## Technical Notes

**Score calculation** (`gameState.js`): Flashscore broadcasts cumulative scores. `lastHomeSeen` / `lastAwaySeen` baseline tracking is used to derive per-minute deltas. When a scraper starts mid-match, the first update sets the baseline and the cell stays at zero — no retroactive data is assumed.

**Stat name resolution** (`computeMetrics`): Flashscore stat labels vary by match type and language. `findStat` tries Turkish/English keyword variants. "Alan Golü" = total FG (not 2P only) — `resolveFg()` auto-detects and separates 2P from total FG to prevent double-counting in eFG%.

**Puppeteer on cloud:** If `PUPPETEER_EXECUTABLE_PATH` env variable is set, system Chromium is used; otherwise Puppeteer uses its bundled Chrome.

---

## Tech Stack

| Package | Version | Usage |
|---------|---------|-------|
| express | ^5.2 | HTTP server, static file serving |
| socket.io | ^4.8 | Real-time bidirectional data transfer |
| puppeteer | ^24 | Headless Chrome for Flashscore scraping |
| chart.js | 4.4.2 (CDN) | Line, radar, bar, doughnut charts |
