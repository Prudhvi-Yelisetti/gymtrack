# Feature walkthrough

Page-by-page notes on what each screen does and where the logic lives
in `src/renderer/app.js`.

## Today (`renderToday`)

- Resolves the current rotation day via `getRotationDay()` (rotation
  array cycles through `trainingPlan.rotation`, e.g. Push → Pull →
  Legs), unless today is the configured rest day, in which case a
  simple recovery-day card is shown instead and nothing is logged.
- Each exercise renders as a block (`renderExerciseBlock`) with:
  - a "last time" hint pulled from the most recent prior session
  - a **progression suggestion** (`getProgressionSuggestion`) — plain
    double-progression logic: if every set at the previous session's
    top working weight hit the top of the rep range, it suggests
    +2.5kg today (highlighted); otherwise it suggests staying at that
    weight and pushing reps toward the top of the range first. Needs
    at least one previous weighted session; says nothing otherwise.
  - one row per set (`renderSetRow`): a done checkbox, reps input,
    weight input; checking "done" with no reps entered auto-fills the
    plan's `repsMax`; reps below `repsMin` get an inline "under target"
    flag
  - a **Rest Timer** button (`startRestTimer`) — counts down from
    `restTimerSeconds`, ticks globally every second regardless of which
    page you're on, and plays a two-beep synthesized tone
    (`playRestDoneSound`, Web Audio, no audio file) on completion
  - a **Plates** toggle (`togglePlateCalc`) — enter a target total and
    get a per-side plate breakdown for a 20kg bar, plus an optional
    warm-up ramp (bar / 50% / 70% / 85%)
- **Finish & Advance Rotation** button increments `rotationIndex`. If
  you've already logged today under a different day name than the
  current pointer, the page locks to a read-only "today's done" view
  instead of letting you start a second session on the same date.
- Header stats: streak, sets done/total, day type, completion status,
  and an estimated-calories figure (blank until a bodyweight is known,
  either logged or set as a reference in Settings).

## History (`renderHistory`)

- Table of every date that has a logged workout, most recent first,
  showing day type, sets done/total, completion status, and the
  estimated-calories figure for that session.
- Clicking a row expands the full session below the table
  (`renderHistoryDetail`): every exercise with its set-by-set
  reps/weight/done status and the session note, if one was written.
  Defaults to the most recent session open.
- **Read-only** — this is a browse/review view. Correcting a past
  session's numbers still isn't supported through the UI (see
  "Known gaps" below); the underlying `state.logs.workouts` data was
  already complete, this just surfaces it.

## Training Plan (`renderTraining`)

- Read-only table view by default (exercise, sets, rep range, RPE) per
  day, to avoid accidental edits while mid-workout.
- **Edit Plan** toggle switches every cell to an input and adds a row
  to add/delete exercises per day; edits autosave on change.

## Diet (`renderDiet`)

- Macro bars (calories/protein/fat/carbs) compare the day's logged
  totals against `dietPlan.targets`. Totals are derived per meal via
  `mealTotals(m)` — manual "other" numbers plus every itemized food
  entry — summed across all meals.
- One block per meal (from `dietPlan.meals`), each with:
  - **Food search** — a text input (backed by a shared `<datalist>`
    populated from `indian-food-database.json`, ~48 common Indian
    foods across grains/breads, dals & legumes, vegetable curries,
    non-veg, dairy, snacks, fruits, and beverages) plus a servings
    multiplier and an Add button. Adding a food computes
    `qty × {calories,protein,fat,carbs}` from the database entry and
    appends it to that meal's `items` list; each logged item shows
    with a remove (×) button.
  - **Other (manual)** — the original four number inputs
    (kcal/protein/fat/carbs), kept as-is for anything not in the
    database (homemade dishes, restaurant food, etc.); these add on
    top of the itemized total rather than replacing it.
  - A per-meal subtotal line showing the combined total.
- The food database is a static bundled reference (loaded once at
  startup into an in-memory `foodDatabase` array), not part of
  persisted `state` — only the itemized entries a user actually logs
  (name/unit/qty/computed macros) get saved into `logs.diet`.
- Hydration: 8 clickable glass icons; clicking glass *n* sets water
  count to *n* (or back to *n-1* if already at *n*, so it's toggle-able).

## Progress (`renderProgress`)

- **Bodyweight log** — quick-add today's weight, plotted on a canvas
  line chart (`drawBodyweightChart` → `drawLineChart`).
- **Exercise history** — dropdown of every exercise name that appears
  anywhere in the training plan (`getAllExerciseNames`); chart shows
  top logged weight per session over time (`getExerciseHistory`).
- **Body measurements** — chest/waist/arms/thighs, all optional per
  entry, one entry per date (updates in place if you log twice today),
  rendered as a table (`renderMeasurementsTable`).
- **Weekly volume** (`renderWeeklyVolume`) — last 7 days.
- **Training consistency heatmap** (`renderHeatmap`) — last 28 days.
- **Personal records table** (`renderPRTable`) — best logged set per
  exercise.

## Settings (`renderSettings`)

- **Rest day** — pick one weekday (0=Sun..6=Sat) that's exempt from
  requiring a workout and never breaks the streak.
- **Default rest timer** — preset buttons (60/90/120/150/180s) or a
  custom value (min 10s).
- **Reference bodyweight** — fallback used for the calorie estimate on
  Today before any real bodyweight entry exists; a logged bodyweight
  entry always takes precedence over this.
- **Import Training Split / Import Diet Plan** — replace the current
  plan wholesale from a JSON file shaped like the bundled defaults;
  logs are untouched.
- **Export All Data** — full state (plans + logs) to a JSON backup file
  via a native save dialog.
- **Import Progress** — restore `logs` (+ rotation index, rest day,
  tracking start date) from a previously exported backup; requires
  confirmation since it overwrites current logs.
- **Reset** — clears all logs/bodyweight/measurements and restarts the
  streak clock; training and diet plans are kept. Irreversible.

## Calorie estimation model

Used on the Today page and driven by `estimateCaloriesBurned`:

1. Needs a bodyweight for the date (`getBodyweightForDate`: most recent
   logged entry on/before the date, else earliest logged entry, else
   the Settings reference weight, else no estimate is shown).
2. Each completed set gets a MET value from `metForSet`, based on
   weight-to-bodyweight ratio (not absolute kg — a 20kg set means
   something very different for a 60kg vs 100kg lifter): <0.3× → 3.5
   MET, <0.75× → 5.0 MET, else 6.0 MET.
3. If ≥2 sets have real `doneAt` timestamps, calories are computed from
   actual elapsed wall-clock time between the first and last completed
   set (plus a modeled duration for the first set itself, since nothing
   precedes its own timestamp).
4. Otherwise (older logs, or only one set done so far), it falls back
   to a modeled tempo (3s/rep) plus rest time between sets at the
   configured rest-timer length.


## Known gaps / roadmap

Compared to a "professional" gym + diet tracker, the biggest missing
pieces, roughly in priority order:

1. ~~**Historical workout browsing**~~ — done, see History above.
2. ~~**Food database**~~ — done, see Diet above. Note: it's a small
   bundled Indian-food reference (~48 items, hand-curated approximate
   macros for common preparations), not a comprehensive/searchable-by-
   barcode database — good enough to log a typical day fast, not a
   substitute for a real nutrition database if precision matters.
3. ~~**Progressive-overload suggestions**~~ — done, see the Today
   section above. Note: it's a simple fixed-2.5kg double-progression
   heuristic, not per-exercise-configurable increments or anything
   RPE-autoregulated — a reasonable v1, not the ceiling.
4. **Multi-program support** — one `trainingPlan` only; no saved
   programs to switch between, no mesocycles/deload weeks.
5. Editing past workout logs (History is currently read-only).
6. Historical diet trends (Diet only ever shows today; Progress has no
   calorie/macro trend chart the way bodyweight does).
7. Superset/circuit support and set types beyond straight sets
   (drop sets, AMRAP, tempo).
8. Warm-up sets aren't logged into the session, only suggested.
9. Exercise library (form cues, muscle-group tags, media) — exercises
   are free-text names only.
10. Progress photos, body-fat % tracking.
11. Multi-user profiles, a units toggle (kg is hardcoded), cloud
    sync/automatic backups (export is manual), and reminders/
    notifications.
