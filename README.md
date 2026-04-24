# basketscrape

A web application that tracks live basketball games in real time via Flashscore, with minute-by-minute score analysis and statistics visualization.

---

## What It Does

- Paste a Flashscore live match link into the app
- The app scrapes the page in the background every 2 seconds
- Scores are recorded minute by minute into a table, and charts update instantly
- The stats panel automatically calculates offensive/defensive efficiency, shot distribution, possession, and more

---

## Setup

```bash
npm install
node server.js
```

Open in browser: `http://localhost:3010`

---

## Usage

1. Paste a Flashscore match link on the home page
2. Click the **Start** button
3. Once the match begins, the `analysis` page updates automatically
4. Click the **☰** button in the top-right corner to open the stats panel

---

## Project Structure

```
basketscrape/
├── server.js          # Express + Socket.io server, /start and /stop endpoints
├── scraper.js         # Puppeteer-based Flashscore scraper, stats fetching
├── gameState.js       # Minute-by-minute score calculation engine
├── public/
│   ├── index.html     # Match link input page
│   ├── app.js         # index.html socket handler
│   ├── analysis.html  # Main analysis page
│   └── analysis.js    # Table, chart, and metric rendering logic
├── algo.md            # Score calculation algorithm documentation
└── formula.md         # Statistics formulas and chart types
```

---

## Tables

A **period × minute** format table for each team:

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | 3 | 0 | 5 | 2 | ... | | | | | |
| Q2 | | | | | | | | | | |

- **Standard table:** points scored in that specific minute
- **×40 table:** minute value × 40 (normalized tempo display)
- **Red center table:** (home + away) × 40 combined total

---

## Stats Panel (☰)

During the match, data is fetched from the Flashscore stats tab every 30 seconds. The panel displays:

### Four Factors Radar (Dean Oliver)

| Metric | Formula | Meaning |
|--------|---------|---------|
| eFG% | `(FGM + 0.5 × 3PM) / FGA` | Shooting efficiency accounting for the value of 3-pointers |
| TOV% | `TOV / (FGA + 0.44×FTA + TOV)` | Turnover rate — lower is better |
| ORB% | `ORB / (ORB + opp_DRB)` | Offensive rebound capture rate |
| FTR  | `FTA / FGA` | Free throw generation rate |

### Efficiency Bar

| Metric | Formula |
|--------|---------|
| OffRtg | `100 × (pts / poss)` |
| DefRtg | `100 × (opp_pts / opp_poss)` |
| NetRtg | `OffRtg − DefRtg` |

### Shot Type Distribution

2-pointer / 3-pointer / Free Throw — layered bar chart showing makes and misses.

### Possession Share

Estimated possession share using: `poss ≈ FGA − ORB + TOV + 0.44 × FTA`

---

## Technologies

| Package | Version | Usage |
|---------|---------|-------|
| express | ^5.2 | HTTP server, static file serving |
| socket.io | ^4.8 | Real-time data transfer |
| puppeteer | ^24 | Headless Chrome for Flashscore scraping |
| chart.js | 4.4.2 (CDN) | Radar, bar, stacked bar, doughnut, line charts |

---

## Technical Notes

**Score calculation algorithm** (`gameState.js`): Flashscore broadcasts cumulative scores. To determine points scored in a specific minute, `lastHomeSeen` / `lastAwaySeen` baseline tracking is used. Multiple updates within the same minute are overwritten; delta calculation is applied on minute transitions.

**Stats keyword matching** (`computeMetrics`): Flashscore stat labels may vary by match type and language. When a match fails, the browser console will show a `[basketscrape] Stat names:` log for debugging.