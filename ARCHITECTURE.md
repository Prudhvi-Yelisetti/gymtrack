# Architecture

## Process model

Standard three-piece Electron setup:

```
main.js  <---IPC--->  preload.js  <---window.gymtrack--->  renderer/app.js
(Node.js,              (contextBridge,                     (browser context,
 file system,           no Node access)                     no Node access)
 dialogs)
```

- **`src/main.js`** — creates the `BrowserWindow`
  (1180×820, `contextIsolation: true`, `nodeIntegration: false`), and
  owns all filesystem access: loading/saving `state.json`, and the
  native file-open/file-save dialogs for JSON import/export.
- **`src/preload.js`** — the only bridge between renderer and main.
  Exposes exactly four methods on `window.gymtrack`:
  `loadState()`, `saveState(state)`, `importJSON()`, `exportJSON(data, name)`.
- **`src/renderer/app.js`** — everything else. Owns all state in a
  single in-memory `state` object, renders the UI by rebuilding
  `innerHTML` on navigation, and calls `persist()` (→ `window.gymtrack
  .saveState`) after every mutation.

## IPC surface (`main.js`)

| Channel | Direction | Purpose |
|---|---|---|
| `state:load` | renderer → main | Read `state.json`, return parsed JSON or `null` |
| `state:save` | renderer → main | Write `state` to `state.json` |
| `dialog:importJSON` | renderer → main | Native open-file dialog, parses & returns JSON (or `{error}`) |
| `dialog:exportJSON` | renderer → main | Native save-file dialog, writes JSON to disk |

## Renderer state shape

Defined by `defaultState()` in `app.js`:

```js
{
  trainingPlan,          // from default-training-plan.json or an import
  dietPlan,               // from default-diet-plan.json or an import
  rotationIndex,          // pointer into trainingPlan.rotation
  restDay,                 // 0=Sunday..6=Saturday
  restTimerSeconds,
  trackingStartDate,       // streak never counts before this date
  referenceBodyweightKg,   // fallback for calorie estimate
  logs: {
    workouts: {},          // date -> { day, note?, exercises: { name: { sets: [...] } } }
    diet: {},               // date -> { meals: { mealName: {calories,protein,fat,carbs} }, water }
    bodyweight: [],         // [{date, kg}]
    measurements: []        // [{date, chest?, waist?, arms?, thighs?}]
  }
}
```

`state` lives only in renderer memory (`let state = null;` at module
scope) and is round-tripped to disk in full on every change — there is
no diffing or partial persistence. Migration of older saves (missing
fields) happens inline in `init()`.

## Rendering model

There is no framework and no virtual DOM. `render()` clears `#app`,
rebuilds the sidebar, and calls `renderPage()`, which dispatches on
`currentPage` (`'today' | 'training' | 'history' | 'diet' | 'progress' |
'settings'`) to one of six top-level render functions. Each of those
sets `main.innerHTML` to a template string and then attaches event
listeners to the resulting nodes. Most mutations end by calling
`render()` or a page-local re-render function again, so the UI is
effectively "re-render the whole page on every change" rather than
targeted DOM patching.

## Key derived-data functions

These are the non-trivial pieces of logic worth knowing about before
changing anything nearby:

- **`ensureWorkoutLog(date, dayName)`** — gets-or-creates today's log,
  and reconciles it against live edits to the training plan (added/
  removed exercises or sets) without disturbing already-logged sets.
- **`getPreviousSession(exName, beforeDate)`** — scans backward through
  `logs.workouts` for the most recent prior session of an exercise, to
  power the "last time" hint next to each input.
- **`computeStreak()`** — walks backward from today; rest days count
  automatically, a fully-completed workout day counts, anything else
  breaks the streak. Today itself is never allowed to retroactively
  break the streak while still in progress.
- **`estimateCaloriesBurned(log, date)`** — MET-based estimate scaled
  by bodyweight (from `getBodyweightForDate`) and load-to-bodyweight
  ratio (`metForSet`). Prefers real elapsed wall-clock time between the
  first and last set's `doneAt` timestamps when ≥2 sets are timestamped;
  falls back to a modeled tempo+rest calculation otherwise (e.g. older
  logs without timestamps).
- **`calculatePlates(target, barWeight)`** — greedy plate-fill from a
  fixed kg plate set (25/20/15/10/5/2.5/1.25), also used by the
  warm-up ramp generator (bar / 50% / 70% / 85% of target).
- **One-training-day-per-calendar-date rule** — if today's date already
  has a log under a different day name than the current rotation
  pointer (i.e. you finished a session and "Finish & Advance Rotation"
  moved the pointer, still same date), `renderToday` shows a locked
  "already done today" view (`renderAlreadyLoggedToday`) instead of
  starting a second session.

## Data import/export

Training plans and diet plans can each be replaced wholesale via
Settings by importing a JSON file matching the shape of
`default-training-plan.json` / `default-diet-plan.json`. Full progress
(all `logs`, plus rotation/rest-day/tracking-start) can be exported and
re-imported as a backup; import validates the shape loosely (checks
for `logs.workouts`/`logs.diet`/`logs.bodyweight`) and requires
confirmation since it overwrites current logs.
