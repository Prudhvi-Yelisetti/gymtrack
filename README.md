# GymTrack

A local-first desktop app for tracking a Push/Pull/Legs training rotation
and a diet/macro plan side by side. Built with Electron; all data is
stored on disk as a single JSON file — no accounts, no network calls.

## Features

- **Today** — shows the current day in your PPL rotation (or your
  scheduled rest day), with per-exercise set logging (reps, weight,
  done-checkbox), a rest timer, and a plate-math calculator with a
  warm-up ramp generator.
- **Training Plan** — view or edit the exercise list for each day
  (sets/rep range/RPE), read-only by default to avoid accidental edits
  mid-workout.
- **History** — browse every past logged session (date, day type,
  completion, estimated calories), with a click-through to full
  set-by-set detail and notes for that day. Read-only.
- **Diet** — daily macro targets (calories/protein/fat/carbs), logged
  per meal either by searching a bundled Indian food database (~48
  common items — dals, breads, curries, snacks, etc. — with
  quantity-scaled macros) or by typing manual/"other" totals for
  anything not in it, plus an 8-glass hydration tracker.
- **Progress** — bodyweight log with a trend chart, per-exercise history
  chart, body measurements (chest/waist/arms/thighs), a 7-day volume
  view, a 28-day consistency heatmap, and a personal-records table.
- **Settings** — rest day, default rest-timer length, reference
  bodyweight (for calorie estimates before you've logged a real
  bodyweight), import/export of training plans, diet plans, and full
  progress backups, plus a full reset.

See `ARCHITECTURE.md` for how the pieces fit together and
`FEATURES.md` for a page-by-page walkthrough of the logic.

## Tech stack

- **Electron 31** (main + renderer, `contextIsolation: true`,
  `nodeIntegration: false`)
- Renderer is plain HTML/CSS/vanilla JS — no framework, no build step
- **electron-builder** for packaging (Linux AppImage target)

## Project layout

```
src/
  main.js              Electron main process — window, IPC, file I/O
  preload.js           contextBridge — exposes window.gymtrack to renderer
  renderer/
    index.html
    style.css
    app.js             All UI logic (~1300 lines, no modules/build step)
    default-training-plan.json
    default-diet-plan.json
    indian-food-database.json  Bundled food reference for Diet's search-and-add
release/                electron-builder output (AppImage, unpacked build)
```

## Running

```bash
npm start        # launches the Electron app (npm install first if needed)
npm run dist      # builds a Linux AppImage into release/
```

## Data storage

State is a single JSON blob saved via Electron's `app.getPath('userData')`,
at `<userData>/gymtrack-data/state.json`. There is no database and no
sync — "backup" means exporting that JSON via Settings → Export All Data.

## Notes for future work

- No `.git` repository was found in this project as of writing these
  docs — consider initializing one.
- No test suite exists.
- `app.js` is a single large file with no module boundaries; splitting
  per-page render functions into separate files would help as the app
  grows.
