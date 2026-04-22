# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A static frontend web app served from GitHub Pages. Students view a monthly assessment calendar; teachers manage entries via a separate authenticated page. Data is stored in a Google Sheet and accessed through a Google Apps Script web app.

No build system, package manager, or test framework — plain HTML/CSS/JS.

## Running locally

Open `index.html` or `teacher.html` directly in a browser, or serve with any static file server:

```bash
python -m http.server 8000
# student page: http://localhost:8000
# teacher page: http://localhost:8000/teacher.html
```

## Deployment setup (one-time, after any backend change)

The Apps Script source lives in `../new_GAS.js` (parent folder). To deploy:

1. Open the Google Sheet ("Vurderinger"), go to **Extensions → Apps Script**.
2. Paste the contents of `new_GAS.js`, replacing any existing code.
3. Fill in `LEGACY_SPREADSHEET_ID` at the top with the ID of the original Forms sheet.
4. **Deploy → New deployment** as a Web App: *Execute as Me*, *Access: Anyone*.
5. Copy the deployment URL.
6. Update `SCRIPT_URL` in **both** `script.js` (student) and `teacher.js` (teacher) to the new URL.
7. In the Script Editor, run `setupPassword("yourChosenPassword")` once to hash and store the teacher password. Do not leave the plaintext password in the code.

After these steps, redeploy the Apps Script any time `new_GAS.js` changes.

## Architecture

**Data flow:**

```
Google Sheet "Vurderinger"  ←──── teacher.js (CRUD via POST)
        ↓
   new_GAS.js (Apps Script web app)
        ↓ (GET ?action=public — merges new + legacy sheet)
      script.js  →  renders calendar
```

**Two-source merge during phase-out:** The Apps Script `getPublicData()` merges the new "Vurderinger" sheet with the legacy "Form Responses 1" sheet so the student calendar shows historical data without migration. Remove the legacy merge from `getPublicData()` after the legacy sheet is retired.

**Authentication:** Password is stored as a SHA-256 hash in Script Properties (server-side). The teacher page POSTs the plaintext password; the backend hashes it and compares. On success it returns a UUID session token stored in browser `sessionStorage` (clears on tab close). No secret ever appears in frontend JS.

**Caching:** Both pages cache fetched data in `localStorage` for 1 hour (`vk_data` / `vk_teacher_data`). A "Oppdater" button bypasses the cache. A full-page overlay blocks interaction during any network fetch.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Student calendar page |
| `script.js` | Student page logic (fetch, filter, render, cache, panel) |
| `styles.css` | Student page styles |
| `teacher.html` | Teacher management page (login + dashboard) |
| `teacher.js` | Teacher page logic (auth, CRUD, conflict detection, cache) |
| `teacher.css` | Teacher page styles |
| `../new_GAS.js` | Apps Script source — paste into Script Editor |

## Key behaviour notes

- **`script.js`:** `SCRIPT_URL` at the top still points to the legacy deployment during Phase 1. Update it to the new URL when deploying Phase 2.
- **`teacher.js`:** `SCRIPT_URL` must be set to the new deployment URL before the teacher page is usable.
- **Class list:** `CLASSES` array in `teacher.js` is hardcoded (`8A`–`8F`, `9A`–`9F`, `10A`–`10F`). Update it each school year.
- **Conflict panel:** triggers on date or class-toggle change, debounced 400 ms, excludes the entry being edited from its own conflict results.
- **`index.txt`** in the repo root is an old draft of `index.html` — it can be deleted.
