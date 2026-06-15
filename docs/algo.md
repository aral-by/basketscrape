# Live Basketball Match Scrape Algorithm

## 1. Startup Process

- User submits a match URL.
- The scraper does not start immediately — it waits for the match to begin.
- While waiting, the system:
  - Reloads the page every 3 seconds.
  - Checks the match status.
- The value checked: period text (e.g. `1st Quarter` or blank/`0`)
- If period is blank or zero → match has not started, keep polling.
- Once a valid period is detected → match has started, launch the main scrape loop.

---

## 2. Main Scrape Loop

- Runs every 2 seconds.
- Data collected each tick:
  - Match time / status (e.g. `4th Quarter 9'`)
  - Score (e.g. `87 - 75`)
- Values are parsed into separate typed variables.

---

## 3. Data Structure

- A 40-cell array is created at startup.
  - 4 quarters × 10 minutes = 40 minutes
- Overtime expands the array dynamically.
  - Each overtime period adds 5 cells.
- Each cell represents points scored during that specific minute (not cumulative).

---

## 4. Minute-Level Score Calculation

### 4.1 Core Formula

All minutes use the same formula:

```
score[minute] = current_scoreboard − cumulative_at_end_of_previous_minute
```

- For the first minute, the previous cumulative is `0`, so the scoreboard value is used directly.
- No special-case logic is needed for the first minute.

### 4.2 Mid-Match Start Protection

If the scraper connects while a match is already in progress (e.g. score is 66–75 at Q4 minute 5), the first update sets a **baseline** and the current cell is left at zero. No retroactive data is assumed.

```
First update received → store as baseline, cell = 0
All subsequent updates → calculate delta from baseline
```

### 4.3 Multiple Updates Within the Same Minute

Since data arrives every 2 seconds, multiple scrapes occur within a single minute. Each new scrape **overwrites** the current cell (does not accumulate).

```
scrape 1 → A:2  B:5   ← overwritten
scrape 2 → A:3  B:6   ← overwritten
scrape 3 → A:6  B:6   ← last snapshot before minute ends → stored
```

> **Note:** Cumulative scores never decrease. Any update where the score is lower than the last seen value is treated as a scrape error and discarded.

### 4.4 Subsequent Minutes

From minute 2 onward, the scoreboard shows a cumulative total, not the per-minute delta.

```
score[n] = scoreboard − last_seen_cumulative
```

---

## 5. Minute Transition

- When the minute changes, writing moves to the new cell.
- The previous cell is finalized and never modified again.
- **Skipped minute detection:** Due to scrape timing, a minute may be missed.
  - On transition, if `currentMinute > lastMinute + 1`, skipped cells are filled with `0`.

```
Example:
- Snapshot at minute 7
- Next scrape: minute 9
- Minute 8 cell → filled with 0 (assumed no score)
- Minute 9 cell → calculated normally
```

---

## 6. Period Normalization

Flashscore resets the minute counter from 1 to 10 each quarter. An absolute minute is computed for array indexing:

```
absoluteMinute = (period - 1) × 10 + minute
cellIndex      = absoluteMinute - 1
```

| Period | Minute | Absolute Minute | Cell Index |
|--------|--------|-----------------|------------|
| 1      | 3      | 3               | 2          |
| 2      | 3      | 13              | 12         |
| 3      | 7      | 27              | 26         |
| 4      | 10     | 40              | 39         |

---

## 7. Match State Checks

States encountered during scraping:

- Quarter break (halftime / between quarters)
- Match not yet started
- Match finished

All states are determined solely from the period text string. The scraper parses it and decides whether to continue, pause, or stop.

---

## 8. Full Flow

```
1. User submits match URL
2. Poll every 3s for match start (valid period text)
3. On match start, launch main scrape loop
4. Every 2s:
   a. Parse (period, minute, homeScore, awayScore)
   b. absoluteMinute = (period - 1) × 10 + minute
   c. If first update ever → set baseline, leave cell at 0
   d. If same minute → overwrite cell with (scoreboard - prevCumulative)
   e. If new minute →
        fill any skipped cells with 0
        cell[absoluteMinute - 1] = scoreboard - lastSeen
        update lastSeen = scoreboard
5. If overtime → expand array by 5 cells
6. Check period text each tick for halftime / finished state
7. On match end → emit final state, close browser
```
