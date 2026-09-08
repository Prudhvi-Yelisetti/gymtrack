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
  per meal either by searching a bundled Indian food database (109
  items across 12 categories — dals, breads, curries, rice &
  biryani dishes, sweets, snacks, common fast food/global items
  eaten in India, etc. — with quantity-scaled macros) or by typing
  manual/"other" totals for anything not in it, plus an 8-glass
  hydration tracker.
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

- No test suite exists.
- `app.js` is a single large file with no module boundaries; splitting
  per-page render functions into separate files would help as the app
  grows.

## Related project

A native Android companion app exists at `~/Projects/gymtrack-android`
— same local-first philosophy, shares the Indian food database and the
training-plan JSON shape (so a program can be exported from one and
imported into the other), but a different starting point: no bundled
default plan, instead an onboarding questionnaire generates one. See
that project's own `README.md` for its status — it's ahead of this
desktop app on some fronts (rest timer, plate calculator, and
progressive-overload hints all exist on both now; multi-program
support and history exist on both; the Android app additionally has a
day-add/rename/delete editor and an exercise-name search database that
this desktop app doesn't have yet) and behind on others (no diet-plan/
editable-meal-list concept, no heatmap/weekly-volume/PR-table views).
