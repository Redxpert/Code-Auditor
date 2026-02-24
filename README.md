# Code Audit Dashboard (Node.js)

A single-file, self-contained Node.js tool that scans source code, computes deep line/quality metrics (code vs comments vs blanks, debt, risk heuristics, minified detection, duplicates), and serves an Apple-style glassmorphism web dashboard + JSON/CSV API.

Single-file Node.js codebase auditor: fast LOC breakdowns, debt/risk signals, duplicates & minified detection, plus a modern web dashboard and JSON/CSV API.

---

## What it does

* Scans one or multiple roots and produces a complete metrics report:

  * Physical lines, blank lines, comment lines, code lines, mixed lines
  * Breakdown by language, project, and directory
  * “Debt” markers (TODO/FIXME/HACK/XXX/BUG/NOTE)
  * “Risk” heuristics (eval, Function, child_process, exec, rm -rf patterns, SQL raw patterns)
  * Minified file heuristics (very long lines / low whitespace ratio)
  * Duplicate detection by content hash (SHA-1)
* Serves a modern web UI:

  * Charts (languages, top dirs, projects code vs comments, distributions)
  * Explorer with sorting/filtering and “include subfolders”
  * Click any file row to open an Inspector sheet with details + duplicates
* Exposes JSON and CSV endpoints for automation/pipelines
<img width="1815" height="1227" alt="imagen" src="https://github.com/user-attachments/assets/12f060bb-c396-4226-91a7-c50f688afaa5" />

---

## Requirements

* Node.js **18+** recommended (works great on Node 20/22/24).
* No dependencies. No build step.

---

## Quick start

1. Put the script in your repo (example name: `line-counter.js`)
2. Run:

```bash
node line-counter.js --root .
```

3. Open the dashboard:

* `http://localhost:3500` (default)
* If 3500 is in use, it automatically tries 3501, 3502, etc.

---

## CLI options

```bash
node line-counter.js [options]
```

Options:

* `--root <path>`
  Add a scan root. You can pass multiple `--root` flags.
* `--port <number>`
  Default: `3500`
* `--noAutoPort`
  Disable auto-increment port fallback.
* `--concurrency <number>`
  Default: `32` (limits parallel file reads to avoid EMFILE)
* `--maxBytes <size>`
  Default: `10mb` (skips files bigger than this)
  Examples: `500k`, `10mb`, `1gb`
* `--largeLines <number>`
  Default: `500` (marks files as “large” at or above this)
* `--ignore <comma,separated,dirs>`
  Adds ignored folder names (in addition to defaults)
* `--onlyExt <comma,separated,exts>`
  Only analyze these extensions (e.g. `--onlyExt js,ts,tsx`)

---

## Web UI tips

* Use **Subfolders** toggle to include nested directories in the file table view.
* Use **Sort** to find:

  * “No comments”: sort by **Coverage** ascending or enable “Sin comentar”.
  * “Risk hotspots”: sort by **Risk** descending.
  * “Debt hotspots”: sort by **Debt** descending.
* Click any file row to open the **Inspector** sheet.

---

## API endpoints

* `GET /api/metrics`
  Lightweight status: scan progress + latest report metadata
* `POST /api/scan`
  Trigger a rescan (debounced: won’t run multiple scans in parallel)
* `GET /api/report`
  Full JSON report
* `GET /api/files?...`
  Paginated/sorted/filtered file list (for the explorer)
* `GET /api/tree?project=...&dir=...`
  Directory children + aggregated stats (drilldown)
* `GET /api/file?project=...&path=...`
  Single-file detail payload + duplicates group
* `GET /api/export.csv?scope=files|languages|projects|dirs`
  CSV export

---

## Notes on performance & accuracy

* This tool uses **streaming reads** and a concurrency limit to handle large repos safely.
* Comment parsing is **heuristic** (not a full AST). It’s designed to be fast and practical for audits, not to perfectly parse every edge case (e.g., complex multi-language templating).
* Binary/unreadable files are skipped automatically.


