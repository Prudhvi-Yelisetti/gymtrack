// ---------- State ----------
let state = null;
let currentPage = 'today';
let trainingPlanEditMode = false; // Training Plan opens read-only by default
                                    // so nothing gets bumped by accident.
let timers = {}; // exerciseName -> {remaining, interval}
let foodDatabase = []; // bundled Indian foods reference — see indian-food-database.json

const todayKey = () => new Date().toISOString().slice(0, 10);

function defaultState(trainingPlan, dietPlan) {
  return {
    trainingPrograms: [trainingPlan], // saved programs; trainingPlan below always aliases the active one
    activeProgramIndex: 0,
    trainingPlan,
    dietPlan,
    rotationIndex: 0,
    restDay: 0, // 0 = Sunday ... 6 = Saturday
    restTimerSeconds: 90,
    trackingStartDate: todayKey(), // streak never counts backward past this
    referenceBodyweightKg: null, // fallback for calorie estimate if no dated bodyweight log exists
    logs: {
      workouts: {},   // date -> { day, exercises: { name: { sets: [{done,reps,weight,short}] } } }
      diet: {},       // date -> { meals: { mealName: {calories,protein,fat,carbs} }, water: n }
      bodyweight: [],  // [{date, kg}]
      measurements: [] // [{date, chest, waist, arms, thighs}] (cm, any field optional)
    }
  };
}

async function init() {
  const saved = await window.gymtrack.loadState();
  foodDatabase = await fetch('indian-food-database.json').then(r => r.json()).catch(() => []);
  if (saved) {
    state = saved;
    if (state.restDay === undefined) state.restDay = 0; // migrate old saves
    if (state.restTimerSeconds === undefined) state.restTimerSeconds = 90;
    if (state.trackingStartDate === undefined) {
      const allDates = [
        ...Object.keys(state.logs.workouts || {}),
        ...Object.keys(state.logs.diet || {}),
        ...(state.logs.bodyweight || []).map(e => e.date)
      ];
      state.trackingStartDate = allDates.length ? allDates.sort()[0] : todayKey();
    }
    if (!state.logs.measurements) state.logs.measurements = [];
    if (state.referenceBodyweightKg === undefined) state.referenceBodyweightKg = null;
    if (!state.trainingPrograms) {
      // Older saves only ever had one plan — wrap it as the sole program.
      // Same object reference, so state.trainingPlan stays a valid alias.
      state.trainingPrograms = [state.trainingPlan];
      state.activeProgramIndex = 0;
    }
    // Older saves have meals as flat {calories,protein,fat,carbs} numbers
    // only. Give every meal an `items` array (itemized food-database
    // entries) without touching those existing manual numbers — they
    // keep working as a separate "other/manual" entry that adds on top.
    Object.values(state.logs.diet || {}).forEach(dayLog => {
      Object.values(dayLog.meals || {}).forEach(m => {
        if (!m.items) m.items = [];
      });
    });
  } else {
    const [trainingPlan, dietPlan] = await Promise.all([
      fetch('default-training-plan.json').then(r => r.json()),
      fetch('default-diet-plan.json').then(r => r.json())
    ]);
    state = defaultState(trainingPlan, dietPlan);
    await persist();
  }
  render();
}

async function persist() {
  await window.gymtrack.saveState(state);
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Helpers ----------
function getRotationDay() {
  const rotation = state.trainingPlan.rotation;
  return rotation[state.rotationIndex % rotation.length];
}

// Switch the active training program. Resets rotationIndex to 0 since a
// different program's rotation array (day names, length) may not line up
// with wherever the previous program's pointer was.
function switchProgram(idx) {
  if (idx < 0 || idx >= state.trainingPrograms.length) return;
  state.activeProgramIndex = idx;
  state.trainingPlan = state.trainingPrograms[idx];
  state.rotationIndex = 0;
}

function emptySet() { return { done: false, reps: null, weight: null, short: false, doneAt: null }; }
function makeEmptySets(n) { return Array.from({ length: n }, emptySet); }

function ensureWorkoutLog(date, dayName) {
  const dayDef = state.trainingPlan.days[dayName];
  let log = state.logs.workouts[date];

  if (!log || log.day !== dayName) {
    // First time today, or the rotation moved to a new day type on the
    // same calendar date (e.g. finishing Push and advancing to Pull
    // without the date changing) — this is genuinely a fresh workout.
    const exercises = {};
    dayDef.exercises.forEach(ex => {
      exercises[ex.name] = { sets: makeEmptySets(ex.sets) };
    });
    log = { day: dayName, exercises };
    state.logs.workouts[date] = log;
    return log;
  }

  // Same day, already in progress. Reconcile against plan edits without
  // touching anything the exercise/set didn't itself change — adding an
  // exercise, or editing one you haven't logged sets for, must never
  // disturb sets you've already checked off elsewhere.
  dayDef.exercises.forEach(ex => {
    if (!log.exercises[ex.name]) {
      // Newly added (or renamed) exercise — starts fresh, nothing else touched.
      log.exercises[ex.name] = { sets: makeEmptySets(ex.sets) };
    } else {
      const sets = log.exercises[ex.name].sets;
      if (ex.sets > sets.length) {
        while (sets.length < ex.sets) sets.push(emptySet());
      } else if (ex.sets < sets.length) {
        sets.length = ex.sets; // trim from the end, keep earliest progress
      }
    }
  });
  return log;
}

// Finds the most recent prior date this exercise was trained, and returns
// its logged sets — used to show "last time" next to the input boxes.
function getPreviousSession(exName, beforeDate) {
  const dates = Object.keys(state.logs.workouts).filter(d => d < beforeDate).sort().reverse();
  for (const d of dates) {
    const log = state.logs.workouts[d];
    const exLog = log.exercises[exName];
    if (exLog && exLog.sets.some(s => s.done)) {
      return { date: d, sets: exLog.sets.filter(s => s.done) };
    }
  }
  return null;
}

// Plain double-progression heuristic: once every logged set from the last
// session hit the top of the rep range, suggest adding weight next time;
// otherwise suggest staying at the same weight and pushing reps up toward
// the top of the range. Weight increments are fixed at 2.5kg (the
// smallest standard plate this app's calculator uses) since there's no
// per-exercise increment configured anywhere yet — a coarser but simple
// default. Returns null when there isn't enough data to say anything
// (no previous session, or no weight logged on it).
function getProgressionSuggestion(exDef, prev) {
  if (!prev || prev.sets.length === 0) return null;
  const weighted = prev.sets.filter(s => s.weight != null);
  if (weighted.length === 0) return null;

  const topWeight = Math.max(...weighted.map(s => s.weight));
  const topSets = weighted.filter(s => s.weight === topWeight);
  const allHitMax = topSets.every(s => (s.reps || 0) >= exDef.repsMax);
  const avgReps = Math.round(topSets.reduce((a, s) => a + (s.reps || 0), 0) / topSets.length);

  if (allHitMax) {
    return { text: `Hit ${exDef.repsMax} reps at ${topWeight}kg last time — try ${topWeight + 2.5}kg today.`, ready: true };
  }
  return { text: `${topWeight}kg last time (avg ${avgReps} reps) — same weight, aim for ${exDef.repsMax} reps before adding load.`, ready: false };
}

// Standard plate set in kg. Greedy fill from largest to smallest.
function calculatePlates(target, barWeight) {
  const PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
  let perSide = Math.max(0, (target - barWeight) / 2);
  const breakdown = [];
  PLATES.forEach(p => {
    const count = Math.floor((perSide + 1e-6) / p);
    if (count > 0) {
      breakdown.push({ plate: p, count });
      perSide -= count * p;
    }
  });
  const achievedPerSide = breakdown.reduce((a, b) => a + b.plate * b.count, 0);
  return {
    breakdown,
    totalWeight: barWeight + achievedPerSide * 2,
    remainder: Math.round(perSide * 2 * 100) / 100
  };
}

function ensureDietLog(date) {
  if (!state.logs.diet[date]) {
    const meals = {};
    (state.dietPlan.meals || []).forEach(m => { meals[m] = { calories: 0, protein: 0, fat: 0, carbs: 0, items: [] }; });
    state.logs.diet[date] = { meals, water: 0 };
  }
  return state.logs.diet[date];
}

// A meal's total macros = its manual/other numbers plus every food-database
// item logged against it. Kept as a function (not stored) so it's always
// derived fresh from whatever's currently in `m`.
function mealTotals(m) {
  const items = m.items || [];
  return {
    calories: (Number(m.calories) || 0) + items.reduce((a, i) => a + i.calories, 0),
    protein: (Number(m.protein) || 0) + items.reduce((a, i) => a + i.protein, 0),
    fat: (Number(m.fat) || 0) + items.reduce((a, i) => a + i.fat, 0),
    carbs: (Number(m.carbs) || 0) + items.reduce((a, i) => a + i.carbs, 0)
  };
}

function isDayFullyDone(log) {
  return Object.values(log.exercises).every(ex => ex.sets.every(s => s.done));
}

// Most recent bodyweight on or before `date`; falls back to the earliest
// entry available if everything logged so far is after that date; null if
// nothing has ever been logged.
function getBodyweightForDate(date) {
  const entries = [...state.logs.bodyweight].sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length > 0) {
    const priorOrSame = [...entries].reverse().find(e => e.date <= date);
    return (priorOrSame || entries[0]).kg;
  }
  return state.referenceBodyweightKg || null; // fallback set in Settings
}

// MET (metabolic equivalent) tier for a working set, based on load
// relative to bodyweight — the standard way resistance training is
// classified by effort in exercise-science MET tables, since absolute
// kg alone doesn't scale burn the way it would for something like
// cycling wattage. A 20kg set means very different things for a 60kg
// vs 100kg lifter, so the ratio is what actually signals effort.
function metForSet(weight, bodyweightKg) {
  if (!weight || !bodyweightKg) return 3.5; // unknown load — assume light/moderate baseline
  const ratio = weight / bodyweightKg;
  if (ratio < 0.3) return 3.5;   // light effort
  if (ratio < 0.75) return 5.0;  // moderate effort
  return 6.0;                    // vigorous effort
}

function estimateCaloriesBurned(log, date) {
  const bw = getBodyweightForDate(date);
  if (!bw) return null;
  const SECONDS_PER_REP = 3;  // controlled concentric+eccentric tempo — only used as a fallback now
  const REST_MET = 1.5;       // standing/light activity between sets, not zero but well below working MET

  const doneSets = [];
  Object.values(log.exercises).forEach(ex => {
    ex.sets.forEach(s => { if (s.done) doneSets.push(s); });
  });
  if (doneSets.length === 0) return 0;

  const timestamped = doneSets
    .filter(s => s.doneAt)
    .sort((a, b) => new Date(a.doneAt) - new Date(b.doneAt));

  if (timestamped.length >= 2) {
    // Real elapsed wall-clock time between your first and last completed
    // set — actual rest included, no tempo guessing. We add the lifting
    // time of the very first set itself back on, since that happened
    // just before its own timestamp was recorded and so isn't captured
    // by the gap between checkpoints.
    const firstAt = new Date(timestamped[0].doneAt).getTime();
    const lastAt = new Date(timestamped[timestamped.length - 1].doneAt).getTime();
    const elapsedSeconds = (lastAt - firstAt) / 1000;
    const firstSetSeconds = (timestamped[0].reps || 0) * SECONDS_PER_REP;
    const totalMinutes = (elapsedSeconds + firstSetSeconds) / 60;
    const avgMet = timestamped.reduce((sum, s) => sum + metForSet(s.weight, bw), 0) / timestamped.length;
    return Math.round(avgMet * 3.5 * bw / 200 * totalMinutes);
  }

  // Fallback for older logs without timestamps, or a session with only
  // one set checked off so far (nothing to measure real elapsed time
  // against yet) — modeled tempo + rest, same approach as before.
  let activeSeconds = 0;
  doneSets.forEach(s => { activeSeconds += (s.reps || 0) * SECONDS_PER_REP; });
  const restMinutes = (Math.max(0, doneSets.length - 1) * state.restTimerSeconds) / 60;
  const activeMinutes = activeSeconds / 60;
  const workMet = doneSets.reduce((sum, s) => sum + metForSet(s.weight, bw), 0) / doneSets.length;
  const calories = workMet * 3.5 * bw / 200 * activeMinutes + REST_MET * 3.5 * bw / 200 * restMinutes;
  return Math.round(calories);
}

const REST_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isRestDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDay() === state.restDay;
}

// Streak = consecutive days ending today where each day is either a completed
// workout day OR the scheduled rest day. Rest days never break the streak.
function computeStreak() {
  let streak = 0;
  let hasWorkout = false; // a streak requires at least one real completed
                           // workout somewhere in the chain — rest days
                           // alone can't conjure a streak out of thin air.
  const d = new Date();
  while (true) {
    const dateStr = d.toISOString().slice(0, 10);
    if (dateStr < state.trackingStartDate) break; // never count before tracking began
    if (isRestDay(dateStr)) {
      streak += 1;
    } else {
      const log = state.logs.workouts[dateStr];
      if (log && isDayFullyDone(log)) {
        streak += 1;
        hasWorkout = true;
      } else {
        // Today in progress shouldn't kill the streak retroactively;
        // only count today as a break once the day has fully passed.
        const isToday = dateStr === todayKey();
        if (isToday) { d.setDate(d.getDate() - 1); continue; }
        break;
      }
    }
    d.setDate(d.getDate() - 1);
  }
  return hasWorkout ? streak : 0;
}

// ---------- Render root ----------
function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.appendChild(renderSidebar());
  const main = document.createElement('div');
  main.className = 'main';
  main.id = 'main';
  app.appendChild(main);
  renderPage();
}

function renderSidebar() {
  const sb = document.createElement('div');
  sb.className = 'sidebar';
  const items = [
    ['today', 'Today'],
    ['training', 'Training Plan'],
    ['history', 'History'],
    ['diet', 'Diet'],
    ['progress', 'Progress'],
    ['settings', 'Settings']
  ];
  sb.innerHTML = `
    <div class="brand">GymTrack</div>
    ${items.map(([id, label]) => `<div class="nav-item ${currentPage === id ? 'active' : ''}" data-page="${id}">${label}</div>`).join('')}
    <div class="sidebar-footer">${state.trainingPlan.name}<br>Rotation: ${state.trainingPlan.rotation.join(' → ')}</div>
  `;
  sb.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      currentPage = el.dataset.page;
      if (currentPage !== 'training') trainingPlanEditMode = false; // reopen read-only next visit
      render();
    });
  });
  return sb;
}

function renderPage() {
  const main = document.getElementById('main');
  if (currentPage === 'today') renderToday(main);
  else if (currentPage === 'training') renderTraining(main);
  else if (currentPage === 'history') renderHistory(main);
  else if (currentPage === 'diet') renderDiet(main);
  else if (currentPage === 'progress') renderProgress(main);
  else if (currentPage === 'settings') renderSettings(main);
}

// ---------- Today ----------
function renderToday(main) {
  const date = todayKey();
  const streak = computeStreak();

  if (isRestDay(date)) {
    main.innerHTML = `
      <h1>Today — Rest Day</h1>
      <div class="page-sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
      <div class="stat-row">
        <div class="stat"><div class="label">Streak</div><div class="value good">${streak} day${streak === 1 ? '' : 's'}</div></div>
        <div class="stat"><div class="label">Day Type</div><div class="value">Rest</div></div>
        <div class="stat"><div class="label">Next Up</div><div class="value">${getRotationDay()}</div></div>
        <div class="stat"><div class="label">Status</div><div class="value good">Scheduled rest</div></div>
      </div>
      <div class="day-card">
        <div class="day-head"><h3>Recovery day — no lifting logged today</h3></div>
        <div class="exercise-block">
          <p style="color:var(--chalk-dim); margin:0 0 10px;">This is your built-in rest day — it doesn't count against your streak. Good use of it: sleep, light walking, mobility work, and hitting your protein target still matter today.</p>
          <p style="color:var(--chalk-dim); margin:0;">Want to train anyway? Change your rest day in Settings, or just head to <span style="color:var(--plate-yellow); cursor:pointer;" id="goto-training">Training Plan</span> to see what's next.</p>
        </div>
      </div>
    `;
    const gotoBtn = main.querySelector('#goto-training');
    if (gotoBtn) gotoBtn.addEventListener('click', () => { currentPage = 'training'; render(); });
    return;
  }

  const dayName = getRotationDay();
  const dayDef = state.trainingPlan.days[dayName];

  // If a workout was already logged today under a DIFFERENT day type (i.e.
  // you finished Push and "Finish & Advance Rotation" moved the pointer to
  // Pull, still on the same calendar date), lock the page instead of
  // silently generating a second workout for today. One training day per
  // calendar date — the next one unlocks tomorrow.
  const existingToday = state.logs.workouts[date];
  if (existingToday && existingToday.day !== dayName) {
    renderAlreadyLoggedToday(main, existingToday, date, dayName, streak);
    return;
  }

  const log = ensureWorkoutLog(date, dayName);

  const totalSets = Object.values(log.exercises).reduce((a, e) => a + e.sets.length, 0);
  const doneSets = Object.values(log.exercises).reduce((a, e) => a + e.sets.filter(s => s.done).length, 0);
  const calories = estimateCaloriesBurned(log, date);

  main.innerHTML = `
    <h1>Today — ${dayName} Day</h1>
    <div class="page-sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    <div class="stat-row cols-5">
      <div class="stat"><div class="label">Streak</div><div class="value good">${streak} day${streak === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="label">Sets Done</div><div class="value ${doneSets === totalSets ? 'good' : ''}">${doneSets} / ${totalSets}</div></div>
      <div class="stat"><div class="label">Day Type</div><div class="value">${dayName}</div></div>
      <div class="stat"><div class="label">Status</div><div class="value ${isDayFullyDone(log) ? 'good' : ''}">${isDayFullyDone(log) ? 'Complete' : 'In progress'}</div></div>
      <div class="stat"><div class="label">Est. Calories</div><div class="value">${calories === null ? '–' : calories}</div></div>
    </div>
    ${calories === null ? `<p class="volume-note" style="margin:-20px 0 24px;">To estimate calories burned, log a bodyweight entry on Progress, or set a quick reference weight in <span style="color:var(--plate-yellow); cursor:pointer;" id="goto-settings">Settings</span>.</p>` : ''}
    <div class="day-card">
      <div class="day-head">
        <span class="tag ${dayName}">${dayName.toUpperCase()}</span>
        <h3>${dayDef.label}</h3>
        <div class="right">
          <button class="primary" id="finish-day-btn">Finish &amp; Advance Rotation</button>
        </div>
      </div>
      <div id="exercise-list"></div>
      <div class="session-notes">
        <label>Session Notes</label>
        <textarea id="session-note" placeholder="How did it feel today? Anything worth remembering next time...">${log.note || ''}</textarea>
      </div>
    </div>
  `;

  const list = main.querySelector('#exercise-list');
  dayDef.exercises.forEach(exDef => {
    list.appendChild(renderExerciseBlock(date, exDef, log.exercises[exDef.name], dayName));
  });
  tickTimers(); // paint any already-running timer immediately, not on next tick

  main.querySelector('#finish-day-btn').addEventListener('click', async () => {
    state.rotationIndex = (state.rotationIndex + 1) % state.trainingPlan.rotation.length;
    await persist();
    toast('Day logged. Next up: ' + getRotationDay());
    render();
  });

  main.querySelector('#session-note').addEventListener('change', async (e) => {
    log.note = e.target.value;
    await persist();
  });

  const gotoSettings = main.querySelector('#goto-settings');
  if (gotoSettings) gotoSettings.addEventListener('click', () => { currentPage = 'settings'; render(); });
}

// Shown instead of the workout screen when today's date already has a
// completed (or in-progress) log under a different day type than the
// current rotation pointer — i.e. you finished today's session and the
// rotation has since moved on. Keeps it to one training day per date.
function renderAlreadyLoggedToday(main, log, date, nextDayName, streak) {
  const totalSets = Object.values(log.exercises).reduce((a, e) => a + e.sets.length, 0);
  const doneSets = Object.values(log.exercises).reduce((a, e) => a + e.sets.filter(s => s.done).length, 0);
  const calories = estimateCaloriesBurned(log, date);
  main.innerHTML = `
    <h1>Today — Done</h1>
    <div class="page-sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    <div class="stat-row cols-5">
      <div class="stat"><div class="label">Streak</div><div class="value good">${streak} day${streak === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="label">Sets Done</div><div class="value good">${doneSets} / ${totalSets}</div></div>
      <div class="stat"><div class="label">Logged As</div><div class="value">${log.day}</div></div>
      <div class="stat"><div class="label">Next Up</div><div class="value">${nextDayName}</div></div>
      <div class="stat"><div class="label">Est. Calories</div><div class="value">${calories === null ? '–' : calories}</div></div>
    </div>
    <div class="day-card">
      <div class="day-head">
        <span class="tag ${log.day}">${log.day.toUpperCase()}</span>
        <h3>Today's ${log.day} session is locked in</h3>
      </div>
      <div class="exercise-block">
        <p style="color:var(--chalk-dim); margin:0 0 10px;">One training day per date keeps your log honest — ${nextDayName} unlocks automatically tomorrow.</p>
        ${log.note ? `<p style="color:var(--chalk-dim); margin:0;"><strong style="color:var(--chalk);">Your note:</strong> ${log.note}</p>` : ''}
      </div>
    </div>
  `;
}

function renderExerciseBlock(date, exDef, exLog, dayName) {
  const block = document.createElement('div');
  block.className = 'exercise-block';
  const prev = getPreviousSession(exDef.name, date);
  const prevText = prev
    ? `Last time (${prev.date.slice(5)}): ` + prev.sets.map(s => `${s.weight ?? '–'}kg×${s.reps ?? '–'}`).join(', ')
    : 'No previous session logged yet';
  const suggestion = getProgressionSuggestion(exDef, prev);
  block.innerHTML = `
    <div class="ex-title-row">
      <span class="name">${exDef.name}</span>
      <span class="target">target ${exDef.repsMin}${exDef.repsMax !== exDef.repsMin ? '–' + exDef.repsMax : ''} reps · RPE ${exDef.rpe}</span>
      <div class="ex-actions">
        <button class="timer-btn" data-ex="${exDef.name}">Rest Timer ${state.restTimerSeconds}s</button>
        <button class="timer-btn" data-role="plates-toggle">Plates</button>
      </div>
    </div>
    <div class="prev-session">${prevText}</div>
    ${suggestion ? `<div class="progression-hint ${suggestion.ready ? 'ready' : ''}">↑ ${suggestion.text}</div>` : ''}
    <div class="sets-holder"></div>
    <div class="plate-calc" id="plates-${cssSafe(exDef.name)}" style="display:none;"></div>
    <div class="timer-display" id="timer-${cssSafe(exDef.name)}" style="display:${timers[exDef.name] ? 'block' : 'none'};"></div>
  `;
  const setsHolder = block.querySelector('.sets-holder');
  exLog.sets.forEach((s, i) => {
    setsHolder.appendChild(renderSetRow(date, exDef, exLog, i, dayName));
  });
  block.querySelector('.timer-btn[data-ex]').addEventListener('click', () => startRestTimer(exDef.name));
  block.querySelector('[data-role="plates-toggle"]').addEventListener('click', () => togglePlateCalc(exDef, exLog, block));
  return block;
}

function togglePlateCalc(exDef, exLog, block) {
  const panel = block.querySelector('.plate-calc');
  const isOpen = panel.style.display !== 'none';
  if (isOpen) { panel.style.display = 'none'; return; }
  const lastWeight = [...exLog.sets].reverse().find(s => s.weight)?.weight || 20;
  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="plate-calc-row">
      <span class="plate-calc-label">Target weight</span>
      <input type="number" id="plate-target" value="${lastWeight}" min="20" step="0.5">
      <span class="unit">kg total · 20kg bar</span>
    </div>
    <div class="plate-calc-result" id="plate-result"></div>
    <div class="warmup-ramp">
      <button class="warmup-toggle" id="warmup-toggle">+ Show warm-up ramp</button>
      <div id="warmup-body" style="display:none;"></div>
    </div>
  `;
  const input = panel.querySelector('#plate-target');
  const resultEl = panel.querySelector('#plate-result');
  const warmupToggle = panel.querySelector('#warmup-toggle');
  const warmupBody = panel.querySelector('#warmup-body');
  let warmupOpen = false;

  function renderWarmup() {
    const target = parseFloat(input.value) || 20;
    const steps = [
      { label: 'Bar only', pct: 0, reps: '8–10' },
      { label: '50%', pct: 0.5, reps: '5' },
      { label: '70%', pct: 0.7, reps: '3' },
      { label: '85%', pct: 0.85, reps: '1–2' }
    ];
    warmupBody.innerHTML = steps.map(s => {
      const weight = s.pct === 0 ? 20 : Math.round((target * s.pct) / 2.5) * 2.5;
      const { breakdown } = calculatePlates(weight, 20);
      const plateText = breakdown.length ? breakdown.map(b => `${b.plate}×${b.count}`).join(', ') : 'bar only';
      return `<div class="warmup-row"><span class="warmup-pct">${s.label}</span><span>${weight}kg × ${s.reps} reps</span><span class="warmup-plates">(${plateText} per side)</span></div>`;
    }).join('');
  }

  function update() {
    const target = parseFloat(input.value) || 20;
    const { breakdown, remainder } = calculatePlates(target, 20);
    if (breakdown.length === 0) {
      resultEl.innerHTML = `<span class="plate-chip bar">just the 20kg bar</span>`;
    } else {
      resultEl.innerHTML = breakdown.map(b => `<span class="plate-chip">${b.plate}kg × ${b.count}</span>`).join('<span class="plate-calc-sep">+</span>');
      resultEl.innerHTML += `<span class="plate-calc-note">per side</span>`;
    }
    if (Math.abs(remainder) > 0.01) {
      resultEl.innerHTML += `<span class="plate-calc-note warn">~${remainder}kg short of exact target with standard plates</span>`;
    }
    if (warmupOpen) renderWarmup();
  }
  warmupToggle.addEventListener('click', () => {
    warmupOpen = !warmupOpen;
    warmupBody.style.display = warmupOpen ? 'block' : 'none';
    warmupToggle.textContent = warmupOpen ? '– Hide warm-up ramp' : '+ Show warm-up ramp';
    if (warmupOpen) renderWarmup();
  });
  input.addEventListener('input', update);
  update();
}

function cssSafe(s) { return s.replace(/[^a-z0-9]/gi, '_'); }

function renderSetRow(date, exDef, exLog, i, dayName) {
  const s = exLog.sets[i];
  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `
    <div class="plate-badge ${dayName}">${i + 1}</div>
    <input type="checkbox" ${s.done ? 'checked' : ''} data-role="done">
    <div class="field-group">
      <input type="number" placeholder="reps" value="${s.reps ?? ''}" data-role="reps" min="0">
      <span class="unit">reps</span>
    </div>
    <div class="field-group">
      <input type="number" placeholder="wt" value="${s.weight ?? ''}" data-role="weight" min="0" step="0.5">
      <span class="unit">kg</span>
    </div>
    <span class="short-note" style="display:${s.short ? 'inline-block' : 'none'}">under target</span>
  `;
  const doneBox = row.querySelector('[data-role="done"]');
  const repsInput = row.querySelector('[data-role="reps"]');
  const weightInput = row.querySelector('[data-role="weight"]');
  const shortNote = row.querySelector('.short-note');

  function evalShort() {
    const r = parseInt(repsInput.value, 10);
    s.short = !isNaN(r) && r < exDef.repsMin;
    shortNote.style.display = s.short ? 'inline-block' : 'none';
  }

  doneBox.addEventListener('change', async () => {
    s.done = doneBox.checked;
    s.doneAt = s.done ? new Date().toISOString() : null; // real timestamp — used to reconstruct actual session duration for calories
    if (s.done && (s.reps === null || s.reps === '')) {
      s.reps = exDef.repsMax;
      repsInput.value = s.reps;
      evalShort();
    }
    await persist();
    updateTodayStats();
  });
  repsInput.addEventListener('change', async () => {
    s.reps = repsInput.value === '' ? null : parseInt(repsInput.value, 10);
    evalShort();
    await persist();
    updateTodayStats(); // reps feed the calorie estimate — keep it live
  });
  weightInput.addEventListener('change', async () => {
    s.weight = weightInput.value === '' ? null : parseFloat(weightInput.value);
    await persist();
    updateTodayStats(); // weight can affect PRs/history shown elsewhere too
  });

  return row;
}

function updateTodayStats() {
  renderPage();
}

// Two short synthesized beeps — no audio asset needed, works offline.
function playRestDoneSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.18].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.18);
    });
  } catch (e) { /* audio not available — fail silently */ }
}

// Timers are tracked by absolute end-time rather than a per-DOM-node
// countdown, and a single global ticker (started once, below) redraws
// whichever timer-display elements currently exist in the DOM. That way
// a re-render (from checking a set, editing reps, switching pages and
// coming back) never orphans a running rest timer — it just picks the
// same countdown back up wherever it finds the matching element, and
// still fires the completion sound even if you've navigated away.
function startRestTimer(exName) {
  timers[exName] = { endTime: Date.now() + state.restTimerSeconds * 1000, notified: false };
  tickTimers(); // paint immediately instead of waiting up to 1s
}

function tickTimers() {
  Object.keys(timers).forEach(exName => {
    const t = timers[exName];
    const display = document.getElementById('timer-' + cssSafe(exName));
    const remaining = Math.ceil((t.endTime - Date.now()) / 1000);
    if (remaining > 0) {
      if (display) {
        display.style.display = 'block';
        display.classList.remove('done');
        display.textContent = `Rest: ${remaining}s`;
      }
    } else if (!t.notified) {
      t.notified = true;
      playRestDoneSound();
      if (display) {
        display.style.display = 'block';
        display.classList.add('done');
        display.textContent = 'Rest done — go!';
      }
      delete timers[exName];
    }
  });
}
setInterval(tickTimers, 1000);

// ---------- History ----------
// Read-only browser over every past logged session — the raw data has
// always lived in state.logs.workouts, this just exposes it. Editing
// past sessions isn't supported yet; this is a browse/review view only.
function renderHistory(main) {
  const dates = Object.keys(state.logs.workouts).sort().reverse();

  if (dates.length === 0) {
    main.innerHTML = `
      <h1>History</h1>
      <div class="page-sub">Every logged session, most recent first.</div>
      <p class="empty-note">No workouts logged yet — sessions you complete on Today will show up here.</p>
    `;
    return;
  }

  main.innerHTML = `
    <h1>History</h1>
    <div class="page-sub">${dates.length} session${dates.length === 1 ? '' : 's'} logged · most recent first. Click a row for the full session.</div>
    <div class="chart-wrap" style="padding:0;">
      <table class="pr-table" id="history-table">
        <tr><th>Date</th><th>Day</th><th>Sets</th><th>Status</th><th>Est. Calories</th></tr>
        ${dates.map(d => {
          const log = state.logs.workouts[d];
          const total = Object.values(log.exercises).reduce((a, e) => a + e.sets.length, 0);
          const done = Object.values(log.exercises).reduce((a, e) => a + e.sets.filter(s => s.done).length, 0);
          const cal = estimateCaloriesBurned(log, d);
          const complete = isDayFullyDone(log);
          return `<tr class="history-row" data-date="${d}">
            <td class="mono">${d}</td>
            <td><span class="tag ${log.day}">${log.day.toUpperCase()}</span></td>
            <td class="mono">${done} / ${total}</td>
            <td class="${complete ? 'good' : ''}">${complete ? 'Complete' : 'Partial'}</td>
            <td class="mono">${cal === null ? '–' : cal}</td>
          </tr>`;
        }).join('')}
      </table>
    </div>
    <div id="history-detail"></div>
  `;

  main.querySelectorAll('.history-row').forEach(row => {
    row.addEventListener('click', () => renderHistoryDetail(main, row.dataset.date));
  });
  renderHistoryDetail(main, dates[0]); // most recent session open by default
}

function renderHistoryDetail(main, date) {
  const log = state.logs.workouts[date];
  const detail = main.querySelector('#history-detail');
  if (!detail || !log) return;

  main.querySelectorAll('.history-row').forEach(r => r.classList.toggle('active', r.dataset.date === date));

  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  detail.innerHTML = `
    <div class="day-card" style="margin-top:22px;">
      <div class="day-head">
        <span class="tag ${log.day}">${log.day.toUpperCase()}</span>
        <h3>${dateLabel}</h3>
      </div>
      ${Object.entries(log.exercises).map(([name, exLog]) => `
        <div class="exercise-block">
          <div class="ex-title-row"><span class="name">${name}</span></div>
          <div class="prev-session">
            ${exLog.sets.map((s, i) => `Set ${i + 1}: ${s.done ? `${s.weight ?? '–'}kg × ${s.reps ?? '–'} reps${s.short ? ' (under target)' : ''}` : 'not logged'}`).join(' &nbsp;·&nbsp; ')}
          </div>
        </div>
      `).join('')}
      ${log.note ? `
      <div class="session-notes">
        <label>Session Notes</label>
        <p style="margin:0; color:var(--chalk-dim); font-size:13.5px;">${log.note}</p>
      </div>` : ''}
    </div>
  `;
}

// ---------- Training plan view ----------
function renderTraining(main) {
  main.innerHTML = `
    <div class="page-head-row">
      <div>
        <h1>Training Plan</h1>
        <div class="page-sub">${state.trainingPlan.name}${trainingPlanEditMode ? ' · edits save automatically' : ''}</div>
      </div>
      <button class="${trainingPlanEditMode ? 'primary' : 'ghost'}" id="edit-toggle">
        ${trainingPlanEditMode ? '✓ Done Editing' : '✎ Edit Plan'}
      </button>
    </div>
  `;

  Object.entries(state.trainingPlan.days).forEach(([dayName, dayDef]) => {
    const card = document.createElement('div');
    card.className = 'day-card';

    const tableRows = trainingPlanEditMode
      ? dayDef.exercises.map((e, i) => `
          <tr data-day="${dayName}" data-idx="${i}">
            <td><input type="text" class="plan-input" data-field="name" value="${e.name}"></td>
            <td><input type="number" class="plan-input mono" data-field="sets" value="${e.sets}" min="1"></td>
            <td><input type="number" class="plan-input mono" data-field="repsMin" value="${e.repsMin}" min="1"></td>
            <td><input type="number" class="plan-input mono" data-field="repsMax" value="${e.repsMax}" min="1"></td>
            <td><input type="text" class="plan-input mono" data-field="rpe" value="${e.rpe}"></td>
            <td><button class="row-delete" data-role="delete-ex" title="Remove exercise">×</button></td>
          </tr>`).join('')
      : dayDef.exercises.map(e => `
          <tr>
            <td>${e.name}</td>
            <td class="mono">${e.sets}</td>
            <td class="mono">${e.repsMin}</td>
            <td class="mono">${e.repsMax}</td>
            <td class="mono">${e.rpe}</td>
          </tr>`).join('');

    card.innerHTML = `
      <div class="day-head">
        <span class="tag ${dayName}">${dayName.toUpperCase()}</span>
        <h3>${dayDef.label}</h3>
      </div>
      <table class="plan-table ${trainingPlanEditMode ? 'edit-table' : ''}">
        <colgroup>
          <col style="width:auto;"><col style="width:60px;"><col style="width:60px;"><col style="width:60px;"><col style="width:84px;">${trainingPlanEditMode ? '<col style="width:36px;">' : ''}
        </colgroup>
        <tr>
          <th>Exercise</th><th>Sets</th><th>Min</th><th>Max</th><th>RPE</th>${trainingPlanEditMode ? '<th></th>' : ''}
        </tr>
        ${tableRows}
      </table>
      ${trainingPlanEditMode ? `
      <div class="add-exercise-row" data-day="${dayName}">
        <input type="text" placeholder="New exercise name" data-new="name">
        <input type="number" placeholder="sets" data-new="sets" min="1" value="3">
        <input type="number" placeholder="min" data-new="repsMin" min="1" value="8">
        <input type="number" placeholder="max" data-new="repsMax" min="1" value="10">
        <input type="text" placeholder="RPE" data-new="rpe" value="6-7">
        <button class="ghost" data-role="add-ex">+ Add Exercise</button>
      </div>` : ''}
    `;
    main.appendChild(card);
  });

  main.querySelector('#edit-toggle').addEventListener('click', () => {
    trainingPlanEditMode = !trainingPlanEditMode;
    renderTraining(main);
  });

  if (trainingPlanEditMode) {
    main.querySelectorAll('.plan-input').forEach(input => {
      input.addEventListener('change', async () => {
        const row = input.closest('tr');
        const dayName = row.dataset.day;
        const idx = parseInt(row.dataset.idx, 10);
        const field = input.dataset.field;
        const ex = state.trainingPlan.days[dayName].exercises[idx];
        if (field === 'name') {
          ex.name = input.value.trim() || ex.name;
        } else if (field === 'rpe') {
          ex.rpe = input.value.trim() || ex.rpe;
        } else {
          ex[field] = Math.max(1, parseInt(input.value, 10) || 1);
        }
        await persist();
        toast('Plan updated');
      });
    });

    main.querySelectorAll('[data-role="delete-ex"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('tr');
        const dayName = row.dataset.day;
        const idx = parseInt(row.dataset.idx, 10);
        const dayDef = state.trainingPlan.days[dayName];
        if (dayDef.exercises.length <= 1) { toast("Can't remove the last exercise in a day"); return; }
        const name = dayDef.exercises[idx].name;
        if (!confirm(`Remove "${name}" from ${dayName} day?`)) return;
        dayDef.exercises.splice(idx, 1);
        await persist();
        toast('Exercise removed');
        renderTraining(main);
      });
    });

    main.querySelectorAll('[data-role="add-ex"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const wrap = btn.closest('.add-exercise-row');
        const dayName = wrap.dataset.day;
        const get = f => wrap.querySelector(`[data-new="${f}"]`);
        const name = get('name').value.trim();
        if (!name) { toast('Enter an exercise name first'); return; }
        const sets = Math.max(1, parseInt(get('sets').value, 10) || 3);
        const repsMin = Math.max(1, parseInt(get('repsMin').value, 10) || 8);
        const repsMax = Math.max(repsMin, parseInt(get('repsMax').value, 10) || repsMin);
        const rpe = get('rpe').value.trim() || '6-7';
        state.trainingPlan.days[dayName].exercises.push({ name, sets, repsMin, repsMax, rpe });
        await persist();
        toast(name + ' added');
        renderTraining(main);
      });
    });
  }

  const hint = document.createElement('div');
  hint.className = 'empty-note';
  hint.textContent = trainingPlanEditMode
    ? 'You can also replace the whole plan at once in Settings → Import Training Plan.'
    : 'Click "Edit Plan" above to change sets, reps, RPE, or add/remove exercises.';
  main.appendChild(hint);
}

// ---------- Diet ----------
function renderDiet(main) {
  const date = todayKey();
  const log = ensureDietLog(date);
  const targets = state.dietPlan.targets;

  const totals = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  Object.values(log.meals).forEach(m => {
    const t = mealTotals(m);
    totals.calories += t.calories;
    totals.protein += t.protein;
    totals.fat += t.fat;
    totals.carbs += t.carbs;
  });

  main.innerHTML = `
    <h1>Diet — ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
    <div class="page-sub">${state.dietPlan.name}</div>
    <div class="macro-grid" id="macro-grid"></div>
    <div class="day-card">
      <div class="day-head"><h3>Meals</h3></div>
      <div id="meal-list"></div>
    </div>
    <div class="day-card">
      <div class="day-head"><h3>Hydration</h3><span style="margin-left:auto; font-family:var(--mono); color:var(--chalk-dim); font-size:12px;">${log.water} / 8 glasses (~${log.water * 300}ml)</span></div>
      <div class="water-row" id="water-row"></div>
    </div>
  `;

  const macroGrid = main.querySelector('#macro-grid');
  [
    ['calories', 'Calories', targets.calories],
    ['protein', 'Protein', targets.protein, 'g'],
    ['fat', 'Fat', targets.fat, 'g'],
    ['carbs', 'Carbs', targets.carbs, 'g']
  ].forEach(([key, label, target, unit]) => {
    const val = totals[key];
    const pct = Math.min(100, Math.round((val / target) * 100));
    const div = document.createElement('div');
    div.className = 'macro';
    div.innerHTML = `
      <div class="n">${Math.round(val)}<span class="n-unit">${unit || ''}</span><span class="of"> / ${target}${unit || ''}</span></div>
      <div class="l">${label}</div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    `;
    macroGrid.appendChild(div);
  });

  // One shared datalist for every meal's food search, populated once.
  // Native <datalist> options are OS/browser-rendered and don't accept
  // custom markup — plain text only, no <span>/CSS possible here — so
  // this is the one spot in the app where the veg/non-veg mark has to
  // be a plain character instead of a real styled dot (see food-item
  // rows below for the CSS version, which is what actually ships once
  // an item is selected/logged).
  if (!document.getElementById('food-db-list')) {
    const dl = document.createElement('datalist');
    dl.id = 'food-db-list';
    dl.innerHTML = foodDatabase.map(f => `<option value="${f.name}">${f.veg ? '🟢' : '🟤'} ${f.unit}</option>`).join('');
    document.body.appendChild(dl);
  }

  const mealList = main.querySelector('#meal-list');
  Object.entries(log.meals).forEach(([mealName, m]) => {
    const mt = mealTotals(m);
    const block = document.createElement('div');
    block.className = 'meal-block';
    block.innerHTML = `
      <div class="meal-block-head">
        <span class="name">${mealName}</span>
        <span class="meal-subtotal">${Math.round(mt.calories)} kcal · ${Math.round(mt.protein)}p / ${Math.round(mt.fat)}f / ${Math.round(mt.carbs)}c</span>
      </div>
      <div class="food-items" id="food-items-${cssSafe(mealName)}"></div>
      <div class="food-search-row">
        <input type="text" list="food-db-list" placeholder="Search Indian foods…" data-role="food-search">
        <input type="number" min="0.25" step="0.25" value="1" data-role="food-qty" title="servings">
        <button class="ghost" data-role="food-add">+ Add</button>
      </div>
      <div class="meal-row manual-row">
        <span class="name">Other (manual)</span>
        <label>kcal <input type="number" data-field="calories" value="${m.calories || ''}" min="0"></label>
        <label>protein g <input type="number" data-field="protein" value="${m.protein || ''}" min="0"></label>
        <label>fat g <input type="number" data-field="fat" value="${m.fat || ''}" min="0"></label>
        <label>carbs g <input type="number" data-field="carbs" value="${m.carbs || ''}" min="0"></label>
      </div>
    `;

    const itemsHolder = block.querySelector('.food-items');
    (m.items || []).forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'food-item-row';
      // Manual/"other" entries won't match anything in foodDatabase, so
      // no dot renders for those — correct, since there's no veg data.
      // Real styled dot (not emoji) since this row is app-owned markup;
      // colors match the Android app's veg/non-veg tokens exactly
      // (#2E7D32 / #8D4B2C) so the same feature looks the same on both.
      const cataloged = foodDatabase.find(f => f.name === item.name);
      const dot = cataloged
        ? `<span class="veg-dot ${cataloged.veg ? 'veg' : 'nonveg'}" title="${cataloged.veg ? 'Veg' : 'Non-veg'}"></span> `
        : '';
      row.innerHTML = `
        <span class="fi-name">${dot}${item.name}</span>
        <span class="fi-qty">${item.qty}× ${item.unit}</span>
        <span class="fi-macros">${Math.round(item.calories)} kcal · ${Math.round(item.protein)}p / ${Math.round(item.fat)}f / ${Math.round(item.carbs)}c</span>
        <button class="row-delete" data-role="remove-item" title="Remove">×</button>
      `;
      row.querySelector('[data-role="remove-item"]').addEventListener('click', async () => {
        m.items.splice(idx, 1);
        await persist();
        renderDiet(main);
      });
      itemsHolder.appendChild(row);
    });

    block.querySelector('[data-role="food-add"]').addEventListener('click', async () => {
      const searchInput = block.querySelector('[data-role="food-search"]');
      const qtyInput = block.querySelector('[data-role="food-qty"]');
      const query = searchInput.value.trim().toLowerCase();
      const qty = parseFloat(qtyInput.value) || 1;
      const food = foodDatabase.find(f => f.name.toLowerCase() === query);
      if (!food) { toast('Pick a food from the list — type to search'); return; }
      m.items = m.items || [];
      m.items.push({
        name: food.name,
        unit: food.unit,
        qty,
        calories: Math.round(food.calories * qty * 10) / 10,
        protein: Math.round(food.protein * qty * 10) / 10,
        fat: Math.round(food.fat * qty * 10) / 10,
        carbs: Math.round(food.carbs * qty * 10) / 10
      });
      await persist();
      toast(`Added ${food.name}`);
      renderDiet(main);
    });

    block.querySelectorAll('.manual-row input').forEach(inp => {
      inp.addEventListener('change', async () => {
        m[inp.dataset.field] = inp.value === '' ? 0 : parseFloat(inp.value);
        await persist();
        renderDiet(main);
      });
    });
    mealList.appendChild(block);
  });

  const waterRow = main.querySelector('#water-row');
  for (let i = 0; i < 8; i++) {
    const g = document.createElement('div');
    g.className = 'water-glass' + (i < log.water ? ' filled' : '');
    g.textContent = '~';
    g.addEventListener('click', async () => {
      log.water = (i + 1 === log.water) ? i : i + 1;
      await persist();
      renderDiet(main);
    });
    waterRow.appendChild(g);
  }
}

// ---------- Progress ----------
function renderProgress(main) {
  main.innerHTML = `
    <h1>Progress</h1>
    <div class="page-sub">Bodyweight, training consistency, and personal records.</div>

    <div class="stat-row cols-2">
      <div class="stat"><div class="label">Current Streak</div><div class="value good">${computeStreak()} day${computeStreak() === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="label">Rest Day</div><div class="value">${REST_DAY_NAMES[state.restDay]}</div></div>
    </div>

    <div class="section">
      <h2>Bodyweight Log</h2>
      <div class="chart-wrap">
        <div class="bw-form">
          <input type="number" id="bw-input" placeholder="weight (kg)" step="0.1" min="0">
          <button class="primary" id="bw-add">Log Today's Weight</button>
        </div>
        <canvas id="bw-canvas" width="900" height="180" style="width:100%; height:180px;"></canvas>
      </div>
    </div>

    <div class="section">
      <h2>Exercise History</h2>
      <div class="chart-wrap">
        <div class="bw-form">
          <select id="exercise-history-select" class="rest-timer-picker-select"></select>
        </div>
        <canvas id="exercise-history-canvas" width="900" height="180" style="width:100%; height:180px;"></canvas>
        <p class="volume-note" id="exercise-history-note"></p>
      </div>
    </div>

    <div class="section">
      <h2>Body Measurements</h2>
      <div class="chart-wrap">
        <div class="measurements-form">
          <label>Chest <input type="number" id="m-chest" placeholder="cm" step="0.5" min="0"></label>
          <label>Waist <input type="number" id="m-waist" placeholder="cm" step="0.5" min="0"></label>
          <label>Arms <input type="number" id="m-arms" placeholder="cm" step="0.5" min="0"></label>
          <label>Thighs <input type="number" id="m-thighs" placeholder="cm" step="0.5" min="0"></label>
          <button class="primary" id="m-add">Log Today</button>
        </div>
        <table class="pr-table" id="measurements-table"></table>
      </div>
    </div>

    <div class="section">
      <h2>Weekly Volume (last 7 days)</h2>
      <div class="chart-wrap" id="volume-wrap"></div>
    </div>

    <div class="section">
      <h2>Training Consistency (last 28 days)</h2>
      <div class="chart-wrap">
        <div class="heatmap" id="heatmap"></div>
      </div>
    </div>

    <div class="section">
      <h2>Personal Records</h2>
      <div class="chart-wrap" style="padding:0;">
        <table class="pr-table" id="pr-table"></table>
      </div>
    </div>
  `;

  main.querySelector('#bw-add').addEventListener('click', async () => {
    const val = parseFloat(main.querySelector('#bw-input').value);
    if (isNaN(val)) { toast('Enter a valid weight'); return; }
    const date = todayKey();
    const existing = state.logs.bodyweight.find(e => e.date === date);
    if (existing) existing.kg = val; else state.logs.bodyweight.push({ date, kg: val });
    state.logs.bodyweight.sort((a, b) => a.date.localeCompare(b.date));
    await persist();
    toast('Weight logged');
    renderProgress(main);
  });

  // Exercise history dropdown + chart
  const exSelect = main.querySelector('#exercise-history-select');
  const exNames = getAllExerciseNames();
  exSelect.innerHTML = exNames.map(n => `<option value="${n}">${n}</option>`).join('');
  function redrawExerciseHistory() {
    const name = exSelect.value;
    const history = getExerciseHistory(name);
    const canvas = main.querySelector('#exercise-history-canvas');
    drawLineChart(canvas, history.map(p => ({ x: p.date, y: p.weight })), {
      unit: ' kg',
      emptyMessage: 'Log at least two sessions with weight logged to see a trend.'
    });
    main.querySelector('#exercise-history-note').textContent = history.length
      ? `${history.length} logged session${history.length === 1 ? '' : 's'} · latest top set: ${history[history.length - 1].weight}kg`
      : 'No sets logged yet for this exercise.';
  }
  if (exNames.length) { exSelect.addEventListener('change', redrawExerciseHistory); redrawExerciseHistory(); }

  // Body measurements
  main.querySelector('#m-add').addEventListener('click', async () => {
    const date = todayKey();
    const entry = { date };
    ['chest', 'waist', 'arms', 'thighs'].forEach(field => {
      const val = parseFloat(main.querySelector('#m-' + field).value);
      if (!isNaN(val)) entry[field] = val;
    });
    if (Object.keys(entry).length === 1) { toast('Enter at least one measurement'); return; }
    const existingIdx = state.logs.measurements.findIndex(e => e.date === date);
    if (existingIdx >= 0) state.logs.measurements[existingIdx] = { ...state.logs.measurements[existingIdx], ...entry };
    else state.logs.measurements.push(entry);
    state.logs.measurements.sort((a, b) => a.date.localeCompare(b.date));
    await persist();
    toast('Measurements logged');
    renderProgress(main);
  });
  renderMeasurementsTable(main.querySelector('#measurements-table'));

  drawBodyweightChart(main.querySelector('#bw-canvas'));
  renderWeeklyVolume(main.querySelector('#volume-wrap'));
  renderHeatmap(main.querySelector('#heatmap'));
  renderPRTable(main.querySelector('#pr-table'));
}

function renderMeasurementsTable(table) {
  const rows = [...state.logs.measurements].reverse().slice(0, 8);
  if (rows.length === 0) {
    table.innerHTML = `<tr><td style="padding:16px 20px; color:var(--chalk-dim);">No measurements logged yet.</td></tr>`;
    return;
  }
  table.innerHTML = `
    <tr><th>Date</th><th>Chest</th><th>Waist</th><th>Arms</th><th>Thighs</th></tr>
    ${rows.map(r => `
      <tr>
        <td class="mono">${r.date}</td>
        <td class="mono">${r.chest ?? '–'}</td>
        <td class="mono">${r.waist ?? '–'}</td>
        <td class="mono">${r.arms ?? '–'}</td>
        <td class="mono">${r.thighs ?? '–'}</td>
      </tr>`).join('')}
  `;
}

function renderWeeklyVolume(container) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const totals = { Push: 0, Pull: 0, Legs: 0 };
  days.forEach(date => {
    const log = state.logs.workouts[date];
    if (!log) return;
    const setsDone = Object.values(log.exercises).reduce((a, ex) => a + ex.sets.filter(s => s.done).length, 0);
    if (totals[log.day] !== undefined) totals[log.day] += setsDone;
  });
  const max = Math.max(1, ...Object.values(totals));
  const rows = Object.entries(totals).map(([day, sets]) => {
    const pct = Math.round((sets / max) * 100);
    return `
      <div class="volume-row">
        <span class="tag ${day}">${day.toUpperCase()}</span>
        <div class="volume-bar-track"><div class="volume-bar-fill ${day}" style="width:${pct}%"></div></div>
        <span class="volume-count">${sets} sets</span>
      </div>`;
  }).join('');
  container.innerHTML = rows + `<p class="volume-note">Beginner target is roughly 8–12 sets per muscle group per week — this counts completed sets from Push/Pull/Legs days in the last 7 days.</p>`;
}

// Generic line chart used by both the bodyweight log and exercise history.
// points: [{x: number, y: number}] already numeric/sorted by x.
function drawLineChart(canvas, points, { unit = '', emptyMessage, color = '#c9a24b' } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) {
    ctx.fillStyle = '#a8a496';
    ctx.font = '13px monospace';
    ctx.fillText(emptyMessage || 'Log at least two entries to see a trend line.', 10, h / 2);
    return;
  }
  const values = points.map(p => p.y);
  const min = Math.min(...values) - 1;
  const max = Math.max(...values) + 1;
  const pad = 20;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p.y - min) / (max - min)) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = color;
  points.forEach((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p.y - min) / (max - min)) * (h - pad * 2);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#a8a496';
  ctx.font = '11px monospace';
  ctx.fillText(max.toFixed(1) + unit, 4, pad);
  ctx.fillText(min.toFixed(1) + unit, 4, h - 6);
}

function drawBodyweightChart(canvas) {
  const data = state.logs.bodyweight.slice(-30);
  drawLineChart(canvas, data.map(d => ({ x: d.date, y: d.kg })), { unit: ' kg' });
}

// All exercise names currently in the plan, for the history dropdown.
function getAllExerciseNames() {
  const names = new Set();
  Object.values(state.trainingPlan.days).forEach(day => {
    day.exercises.forEach(e => names.add(e.name));
  });
  return [...names];
}

// For a given exercise, the best (heaviest) completed set per date, in order.
function getExerciseHistory(exName) {
  const dates = Object.keys(state.logs.workouts).sort();
  const points = [];
  dates.forEach(date => {
    const exLog = state.logs.workouts[date].exercises[exName];
    if (!exLog) return;
    const doneSets = exLog.sets.filter(s => s.done && s.weight);
    if (doneSets.length === 0) return;
    const top = Math.max(...doneSets.map(s => s.weight));
    points.push({ date, weight: top });
  });
  return points;
}

function renderHeatmap(container) {
  container.innerHTML = '';
  const days = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  days.forEach(date => {
    const log = state.logs.workouts[date];
    const cell = document.createElement('div');
    cell.className = 'heat-cell';
    cell.title = date;
    if (isRestDay(date)) {
      cell.classList.add('rest');
      cell.title += ' — scheduled rest';
    } else if (log && isDayFullyDone(log)) {
      cell.classList.add('done', log.day);
      cell.title += ' — ' + log.day + ' complete';
    }
    container.appendChild(cell);
  });
}

function renderPRTable(table) {
  const prs = {};
  Object.entries(state.logs.workouts).forEach(([date, log]) => {
    Object.entries(log.exercises).forEach(([exName, exLog]) => {
      exLog.sets.forEach(s => {
        if (!s.done || !s.weight || !s.reps) return;
        const cur = prs[exName];
        if (!cur || s.weight > cur.weight || (s.weight === cur.weight && s.reps > cur.reps)) {
          prs[exName] = { weight: s.weight, reps: s.reps, date };
        }
      });
    });
  });
  const rows = Object.entries(prs);
  if (rows.length === 0) {
    table.innerHTML = `<tr><td style="padding:16px 20px; color:var(--chalk-dim);">No PRs logged yet — log weight and reps on the Today page to start tracking.</td></tr>`;
    return;
  }
  table.innerHTML = `
    <tr><th>Exercise</th><th>Best</th><th>Date</th></tr>
    ${rows.map(([name, pr]) => `<tr><td>${name}</td><td style="font-family:var(--mono);">${pr.weight}kg × ${pr.reps}</td><td style="font-family:var(--mono); color:var(--chalk-dim);">${pr.date}</td></tr>`).join('')}
  `;
}

// ---------- Settings ----------
function renderSettings(main) {
  main.innerHTML = `
    <h1>Settings</h1>
    <div class="page-sub">Import plans, back up your data, or start fresh.</div>

    <div class="settings-block">
      <h4>Rest Day</h4>
      <p>Pick one day a week as scheduled rest. It won't require a workout and won't break your streak.</p>
      <div class="rest-day-picker" id="rest-day-picker">
        ${REST_DAY_NAMES.map((name, i) => `<button data-day="${i}" class="${state.restDay === i ? 'active' : ''}">${name.slice(0, 3)}</button>`).join('')}
      </div>
    </div>

    <div class="settings-block">
      <h4>Default Rest Timer</h4>
      <p>How long the rest timer counts down between sets. Suggested: 60–90s for isolation moves, 90–180s for heavy compound lifts like squat, bench, and deadlift.</p>
      <div class="rest-timer-picker" id="rest-timer-picker">
        ${[60, 90, 120, 150, 180].map(s => `<button data-secs="${s}" class="${state.restTimerSeconds === s ? 'active' : ''}">${s}s</button>`).join('')}
        <input type="number" id="rest-timer-custom" placeholder="custom" min="10" step="5" value="${[60,90,120,150,180].includes(state.restTimerSeconds) ? '' : state.restTimerSeconds}">
      </div>
    </div>

    <div class="settings-block">
      <h4>Reference Bodyweight</h4>
      <p>Used to estimate calories burned on days you haven't logged a bodyweight entry on Progress. A dated bodyweight log entry is always preferred when one exists — this is just the fallback so calories don't sit blank until you log one.</p>
      <div class="rest-timer-picker">
        <input type="number" id="reference-bw" placeholder="e.g. 70" min="20" step="0.5" value="${state.referenceBodyweightKg ?? ''}">
        <span class="unit">kg</span>
        <button class="ghost" id="reference-bw-save">Save</button>
      </div>
    </div>

    <div class="settings-block">
      <h4>Training Programs</h4>
      <p>Switch between saved programs, or import a new one from a JSON file (same shape as the bundled default) without losing the ones you already have. Workout logs are kept separately either way and are never affected by switching.</p>
      <div class="program-list" id="program-list">
        ${state.trainingPrograms.map((p, i) => `
          <div class="program-row ${i === state.activeProgramIndex ? 'active' : ''}">
            <div class="program-info">
              <span class="program-name">${p.name}</span>
              <span class="program-meta">${p.rotation.join(' → ')}</span>
            </div>
            ${i === state.activeProgramIndex
              ? `<span class="tag active-tag">Active</span>`
              : `<button class="ghost" data-role="switch-program" data-idx="${i}">Switch</button>`}
            ${state.trainingPrograms.length > 1 && i !== state.activeProgramIndex
              ? `<button class="row-delete" data-role="delete-program" data-idx="${i}" title="Delete">×</button>`
              : ''}
          </div>
        `).join('')}
      </div>
      <div class="settings-actions">
        <button class="ghost" id="import-training">Import as New Program</button>
      </div>
    </div>

    <div class="settings-block">
      <h4>Import Diet Plan</h4>
      <p>Replace calorie/macro targets and meal list with a JSON file.</p>
      <div class="settings-actions">
        <button class="ghost" id="import-diet">Import Diet JSON</button>
      </div>
    </div>

    <div class="settings-block">
      <h4>Export All Data</h4>
      <p>Save your full state — plans, logs, bodyweight history — as a JSON backup file.</p>
      <div class="settings-actions">
        <button class="ghost" id="export-all">Export Backup</button>
      </div>
    </div>

    <div class="settings-block">
      <h4>Import Progress</h4>
      <p>Restore workout logs, diet logs, bodyweight history, streak, and rest day from a previously exported backup file. This replaces your current logs — export a backup first if you want to keep them.</p>
      <div class="settings-actions">
        <button class="ghost" id="import-progress">Import Progress JSON</button>
      </div>
    </div>

    <div class="settings-block">
      <h4>Reset</h4>
      <p>Clears all logs, bodyweight history, and rotation progress. Plans are kept. This cannot be undone.</p>
      <div class="settings-actions">
        <button class="ghost" id="reset-logs" style="border-color:var(--plate-red); color:var(--plate-red);">Reset All Logs</button>
      </div>
    </div>
  `;

  main.querySelectorAll('#rest-day-picker button').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.restDay = parseInt(btn.dataset.day, 10);
      await persist();
      toast('Rest day set to ' + REST_DAY_NAMES[state.restDay]);
      render();
    });
  });

  main.querySelectorAll('#rest-timer-picker button').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.restTimerSeconds = parseInt(btn.dataset.secs, 10);
      await persist();
      toast('Rest timer set to ' + state.restTimerSeconds + 's');
      render();
    });
  });

  main.querySelector('#rest-timer-custom').addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10);
    if (!val || val < 10) { toast('Enter at least 10 seconds'); return; }
    state.restTimerSeconds = val;
    await persist();
    toast('Rest timer set to ' + val + 's');
    render();
  });

  main.querySelector('#reference-bw-save').addEventListener('click', async () => {
    const val = parseFloat(main.querySelector('#reference-bw').value);
    if (!val || val < 20) { toast('Enter a valid bodyweight'); return; }
    state.referenceBodyweightKg = val;
    await persist();
    toast('Reference bodyweight saved');
  });

  main.querySelectorAll('[data-role="switch-program"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      switchProgram(parseInt(btn.dataset.idx, 10));
      await persist();
      toast('Switched to ' + state.trainingPlan.name);
      render();
    });
  });

  main.querySelectorAll('[data-role="delete-program"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const p = state.trainingPrograms[idx];
      if (!confirm(`Delete "${p.name}"? This only removes the plan — any workout logs already recorded under it are kept.`)) return;
      state.trainingPrograms.splice(idx, 1);
      if (idx < state.activeProgramIndex) state.activeProgramIndex--; // keep pointing at the same program
      await persist();
      toast('Program deleted');
      render();
    });
  });

  main.querySelector('#import-training').addEventListener('click', async () => {
    const data = await window.gymtrack.importJSON();
    if (!data) return;
    if (data.error || !data.days || !data.rotation) { toast('Invalid training plan file'); return; }
    state.trainingPrograms.push(data);
    switchProgram(state.trainingPrograms.length - 1);
    await persist();
    toast('Program imported and switched to');
    render();
  });

  main.querySelector('#import-diet').addEventListener('click', async () => {
    const data = await window.gymtrack.importJSON();
    if (!data) return;
    if (data.error || !data.targets) { toast('Invalid diet plan file'); return; }
    state.dietPlan = data;
    await persist();
    toast('Diet plan imported');
    render();
  });

  main.querySelector('#export-all').addEventListener('click', async () => {
    const ok = await window.gymtrack.exportJSON(state, 'gymtrack-backup.json');
    if (ok) toast('Backup saved');
  });

  main.querySelector('#import-progress').addEventListener('click', async () => {
    const data = await window.gymtrack.importJSON();
    if (!data) return;
    if (data.error || !data.logs || !data.logs.workouts || !data.logs.diet || !data.logs.bodyweight) {
      toast('Invalid progress file — expected a GymTrack backup export');
      return;
    }
    if (!confirm('This replaces your current workout logs, diet logs, and bodyweight history with the imported file. Continue?')) return;
    state.logs = data.logs;
    if (!state.logs.measurements) state.logs.measurements = []; // older backups won't have this
    if (typeof data.rotationIndex === 'number') state.rotationIndex = data.rotationIndex;
    if (typeof data.restDay === 'number') state.restDay = data.restDay;
    if (typeof data.trackingStartDate === 'string') state.trackingStartDate = data.trackingStartDate;
    await persist();
    toast('Progress imported');
    render();
  });

  main.querySelector('#reset-logs').addEventListener('click', async () => {
    if (!confirm('This clears all workout logs, diet logs, and bodyweight history. Continue?')) return;
    state.logs = { workouts: {}, diet: {}, bodyweight: [], measurements: [] };
    state.rotationIndex = 0;
    state.trackingStartDate = todayKey(); // restart the streak clock too
    await persist();
    toast('All logs cleared');
    render();
  });
}

init();
