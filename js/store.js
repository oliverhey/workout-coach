// App state, defaults and data helpers.
import { db } from './db.js';

// kind: 'split' = rotating main days (drive "Up next" and plans), 'free' = off-cycle extra workout (no fixed plan),
// 'travel' = TRX / Bandit bands (own plan, outside the rotation; loads are band levels or bodyweight).
export const DEFAULT_DAYS = [
  { id: 'd1', name: 'Chest & Triceps', color: '#e4171f', kind: 'split' },
  { id: 'd2', name: 'Back & Biceps', color: '#f4f1ea', kind: 'split' },
  { id: 'd3', name: 'Legs & Shoulders', color: '#8a857c', kind: 'split' },
  { id: 'd4', name: 'Free', color: '#5f5b55', kind: 'free' },
  { id: 'd5', name: 'TRX & Bands', color: '#f2a531', kind: 'travel' },
];
export const splitDays = () => state.days.filter(d => (d.kind || 'split') === 'split');
export const planDays = () => state.days.filter(d => d.kind !== 'free');

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-sonnet-5-5',
  goal: 'Lose body fat while building muscle (hypertrophy focus). Train a 3-day split, each day roughly once a week or more.',
  rules: [
    'Track pain per set on a 0–10 scale. Do not progress load on a movement while pain is 3/10 or higher; reduce or substitute instead.',
    'Stop an exercise if pain reaches 4/10. Never use extra sets just to confirm that something hurts.',
    'No spotter: no grinding failed reps on barbell pressing.',
    'Different cable towers/machines are not directly comparable in kg.',
    'Prefer small load jumps; consolidate reps before adding weight.',
  ].join('\n'),
  coachStyle: 'Direct and specific, like a good personal coach. Rate the session out of 10. Say what went well and what did not, compare against previous sessions with a short table, and explain any change you make to the plan. Never invent data that was not logged.',
  historyDepth: 8,
  // TRX Bandit bands: colour = resistance in kg at mid-stretch (manufacturer range in brackets). Edit in Settings.
  bands: 'green = 10.2 kg (6.8–13.6 kg)\nblue = 4.5 kg (2.3–6.8 kg)\nyellow = 17 kg (11.3–22.7 kg)\norange = 23.8 kg (15.9–31.8 kg)',
};

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  days: DEFAULT_DAYS.map(d => ({ ...d })),
  plans: {},          // dayId -> plan
  sessions: [],       // all sessions
  reports: [],        // progress reports
  usage: { input: 0, output: 0 },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
export const fmtDate = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', opts);
};
export const daysAgo = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  const a = new Date(y, m - 1, d); const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
};

export async function loadAll() {
  const [settings, days, plans, reports, usage, sessions] = await Promise.all([
    db.get('settings'), db.get('days'), db.get('plans'), db.get('reports'), db.get('usage'), db.getAllSessions(),
  ]);
  if (settings) state.settings = { ...DEFAULT_SETTINGS, ...settings };
  if (/^\s*green\s*=\s*2\s*\n\s*blue\s*=\s*1\s*$/i.test(state.settings.bands || '')) state.settings.bands = DEFAULT_SETTINGS.bands; // old placeholder strengths → real kg values
  if (days && days.length) state.days = days;
  // migrate: older installs only had the three split days
  let changed = false;
  for (const d of state.days) if (!d.kind) { d.kind = (DEFAULT_DAYS.find(x => x.id === d.id) || {}).kind || 'split'; changed = true; }
  for (const def of DEFAULT_DAYS) if (!state.days.find(d => d.id === def.id)) { state.days.push({ ...def }); changed = true; }
  if (changed) await db.set('days', state.days);
  if (plans) state.plans = plans;
  if (reports) state.reports = reports;
  if (usage) state.usage = usage;
  state.sessions = sessions || [];
  sortSessions();
  const seeded = await db.get('seeded');
  if (!seeded) { seedStarterPlans(); await db.set('plans', state.plans); await db.set('seeded', true); }
}

export const save = {
  settings: () => db.set('settings', state.settings),
  days: () => db.set('days', state.days),
  plans: () => db.set('plans', state.plans),
  reports: () => db.set('reports', state.reports),
  usage: () => db.set('usage', state.usage),
  session: s => db.putSession(s),
};

export function sortSessions() {
  state.sessions.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0));
}

export const dayById = id => state.days.find(d => d.id === id) || { id, name: 'Other', color: '#a69cc0' };
export const doneSessions = () => state.sessions.filter(s => s.status === 'done');
export const draftSession = () => state.sessions.find(s => s.status === 'draft');
export const sessionsForDay = dayId => doneSessions().filter(s => s.dayId === dayId);
export const lastSessionForDay = dayId => sessionsForDay(dayId)[0];

// ---------- numbers ----------
export const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
export const e1rm = (w, r) => (w && r ? w * (1 + Math.min(r, 20) / 30) : 0);
export const fmtW = w => (w == null ? '?' : (Math.round(w * 100) / 100).toString());

// ---------- resistance bands ----------
const BAND_HEX = { green: '#36c56b', blue: '#3b82f6', red: '#e4171f', black: '#111111', yellow: '#f2c531', orange: '#f28a31', purple: '#9b6bff', grey: '#9a958c', gray: '#9a958c', white: '#f4f1ea', pink: '#ff7ab6' };
export function bandList() {
  return String(state.settings.bands || '').split(/\n|,/).map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^([a-zäöüß ]+?)\s*(?:=|:)\s*([\d.,]+)\s*(?:kg)?\s*(.*)$/i);
    const name = (m ? m[1] : l).trim().toLowerCase();
    return { name, value: m ? Number(m[2].replace(',', '.')) : 1, range: m ? m[3].replace(/^[(\s]+|[)\s]+$/g, '') : '', hex: BAND_HEX[name] || '#9a958c' };
  });
}
export function parseBand(str) {
  const out = {};
  for (const m of String(str || '').toLowerCase().matchAll(/(\d+)\s*([a-zäöüß]+)/g)) out[m[2]] = (out[m[2]] || 0) + Number(m[1]);
  return out;
}
export function fmtBand(obj) {
  const order = bandList().map(b => b.name);
  const keys = Object.keys(obj).filter(k => obj[k] > 0).sort((a, b) => (order.indexOf(a) + 99 * (order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * (order.indexOf(b) < 0)));
  return keys.map(k => `${obj[k]} ${k}`).join(' / ');
}
export function bandLoad(str) {
  const vals = Object.fromEntries(bandList().map(b => [b.name, b.value]));
  return Object.entries(parseBand(str)).reduce((a, [k, n]) => a + n * (vals[k] ?? 1), 0);
}
export const bandHex = name => (bandList().find(b => b.name === name) || {}).hex || BAND_HEX[name] || '#9a958c';
// Effective load of a set: kg, or band strength units for band sets.
export const effW = s => (s.band ? bandLoad(s.band) : s.w);
export const isBandDay = dayId => dayById(dayId).kind === 'travel';

export function fmtSet(s, { pain = true } = {}) {
  const load = s.band ? s.band : s.w == null && s.r != null && s.bw ? 'BW' : fmtW(s.w);
  const base = `${load}×${s.r == null ? '?' : s.r}`;
  const p = pain && s.pain != null ? ` @${s.pain}/10` : '';
  return (s.wu ? 'wu ' : '') + base + p;
}

export function topSet(ex) {
  let best = null;
  for (const s of ex.sets || []) {
    const w = effW(s);
    if (s.wu || w == null || s.r == null) continue;
    if (!best || e1rm(w, s.r) > e1rm(effW(best), best.r)) best = s;
  }
  return best;
}

export function maxPain(ex) {
  const p = (ex.sets || []).map(s => s.pain).filter(x => x != null);
  return p.length ? Math.max(...p) : null;
}

export function volume(ex) {
  return (ex.sets || []).filter(s => !s.wu && s.w != null && s.r != null).reduce((a, s) => a + s.w * s.r, 0);
}

export const normName = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function allExerciseNames() {
  const map = new Map();
  for (const s of doneSessions()) for (const ex of s.exercises || []) {
    const k = normName(ex.name); if (!k) continue;
    const cur = map.get(k) || { name: ex.name, count: 0, last: s.date };
    cur.count++; map.set(k, cur);
  }
  for (const p of Object.values(state.plans)) for (const ex of p.exercises || []) {
    const k = normName(ex.name); if (!map.has(k)) map.set(k, { name: ex.name, count: 0, last: null });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function lastPerformance(name, beforeDate, excludeId) {
  const k = normName(name);
  for (const s of doneSessions()) {
    if (excludeId && s.id === excludeId) continue;
    if (beforeDate && s.date > beforeDate) continue;
    const ex = (s.exercises || []).find(e => normName(e.name) === k);
    if (ex && ex.sets && ex.sets.length) return { session: s, ex };
  }
  return null;
}

// ---------- text for the AI ----------
export function sessionToText(s, { withAnalysis = false } = {}) {
  const day = dayById(s.dayId);
  const lines = [];
  const rating = s.analysis && s.analysis.rating != null ? ` (rated ${s.analysis.rating}/10)` : '';
  lines.push(`### ${s.date} — ${s.title || day.name}${rating}`);
  if (s.bodyweight) lines.push(`Body weight: ${s.bodyweight} kg`);
  for (const ex of s.exercises || []) {
    const sets = (ex.sets || []).filter(x => x.w != null || x.r != null || x.done);
    const setTxt = sets.length ? sets.map(x => fmtSet(x)).join(', ') : '(listed, no sets recorded)';
    lines.push(`- ${ex.name}: ${setTxt}${ex.userNote ? ` — note: ${ex.userNote}` : ''}`);
  }
  if (s.notes) lines.push(`Session notes: ${s.notes}`);
  if (withAnalysis && s.analysis && s.analysis.summary) lines.push(`Coach summary then: ${s.analysis.summary}`);
  return lines.join('\n');
}

export function planToText(p) {
  if (!p) return '(no plan)';
  const lines = [];
  if (p.generalNote) lines.push(`General: ${p.generalNote}`);
  for (const ex of p.exercises || []) {
    lines.push(`- ${ex.name}: ${(ex.sets || []).map(s => `${s.wu ? 'wu ' : ''}${s.band ? s.band : s.w == null ? (s.bw ? 'BW' : '?') : fmtW(s.w)}×${s.r ?? '?'}`).join(', ')}${ex.note ? ` — ${ex.note}` : ''}`);
  }
  return lines.join('\n');
}

// Long-term per-exercise bests, compact.
export function exerciseBestsText(limit = 40) {
  const map = new Map();
  for (const s of [...doneSessions()].reverse()) for (const ex of s.exercises || []) {
    const t = topSet(ex); if (!t) continue;
    const k = normName(ex.name);
    const cur = map.get(k) || { name: ex.name, first: null, best: null, last: null, n: 0 };
    const rec = { date: s.date, w: t.band || t.w, r: t.r, e: e1rm(effW(t), t.r) };
    if (!cur.first) cur.first = rec;
    if (!cur.best || rec.e > cur.best.e) cur.best = rec;
    cur.last = rec; cur.n++; map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.n - a.n).slice(0, limit)
    .map(x => `- ${x.name} (${x.n} sessions): first ${x.first.w}×${x.first.r} on ${x.first.date}; best ${x.best.w}×${x.best.r} on ${x.best.date}; latest ${x.last.w}×${x.last.r} on ${x.last.date}`).join('\n');
}

// ---------- plan → draft session ----------
export function newSessionFromPlan(dayId) {
  const isFree = dayById(dayId).kind === 'free';
  const plan = isFree ? null : state.plans[dayId];
  const last = isFree ? null : lastSessionForDay(dayId);
  const exercises = [];
  if (plan && plan.exercises && plan.exercises.length) {
    for (const pe of plan.exercises) {
      exercises.push({ id: uid(), name: pe.name, note: pe.note || '', userNote: '',
        sets: (pe.sets && pe.sets.length ? pe.sets : [{ w: null, r: null }]).map(ps => ({ w: null, r: null, pain: null, wu: !!ps.wu, done: false, tw: ps.w ?? null, tr: ps.r ?? null, tb: ps.band || null })) });
    }
  } else if (last) {
    for (const le of last.exercises) {
      exercises.push({ id: uid(), name: le.name, note: '', userNote: '',
        sets: le.sets.map(ls => ({ w: null, r: null, pain: null, wu: !!ls.wu, done: false, tw: ls.w, tr: ls.r != null ? String(ls.r) : null, tb: ls.band || null })) });
    }
  }
  return {
    id: uid(), date: todayISO(), dayId, title: dayById(dayId).name, status: 'draft', startedAt: Date.now(),
    bodyweight: null, notes: '', exercises, analysis: null, source: 'app', planNote: plan ? plan.generalNote || '' : '',
  };
}

export function suggestNextDay() {
  // The configured day trained least recently (or never) comes next.
  let best = null, bestDate = null;
  for (const d of splitDays()) {
    const last = lastSessionForDay(d.id);
    const date = last ? last.date : '0000-00-00';
    if (best == null || date < bestDate) { best = d.id; bestDate = date; }
  }
  return best;
}

// Starter plans from the targets in the August notes (replaced by the first AI review or by "Rebuild plans").
function seedStarterPlans() {
  const P = (name, note, sets) => ({ name, note, sets: sets.map(([w, r, wu]) => ({ w, r: String(r), wu: !!wu })) });
  state.plans = {
    d1: { dayId: 'd1', origin: 'starter', createdAt: Date.now(), generalNote: 'Starter plan from your mid-August targets. Finish a session or use "Rebuild plans" after importing history to get fresh targets.', exercises: [
      P('Barbell Flat Bench Press', 'Aim 65×6–7 before trying 70. No grinding without a spotter.', [[40, 15, 1], [50, 8], [55, 8], [60, 6], [65, '6-7'], [55, 9]]),
      P('Machine Chest Press', 'Progress to 65×8–10.', [[45, 12], [55, 12], [65, '8-10'], [50, 13]]),
      P('Incline Machine Press', 'Test with fresh shoulders.', [[50, 10], [55, '8-10'], [55, '8-10']]),
      P('Seated Dip Machine', 'Next target 117.5×5–7.', [[80, 15], [100, 10], [110, 7], [117.5, '5-7'], [80, 15]]),
      P('EZ-Bar Nose Breakers', 'Build toward 20×12 before adding weight.', [[10, 15, 1], [20, 10], [20, 10], [20, '8-10']]),
      P('V-Grip Pushdowns', '', [[25, 15], [35, 8], [35, 8], [25, 12]]),
    ] },
    d2: { dayId: 'd2', origin: 'starter', createdAt: Date.now(), generalNote: 'Starter plan from your mid-August targets.', exercises: [
      P('Lat Pulldown', 'Goal 80×8 at ≤2/10 pain. Do not jump to 82.5 yet.', [[50, 15], [60, 10], [70, 8], [80, 8], [70, 10], [60, 12]]),
      P('Seated Cable Row (neutral grip)', '92.5×8–10, no jump to 95.', [[60, 12], [70, 10], [80, 8], [92.5, '8-10'], [70, 12]]),
      P('T-Bar Row', 'Keep load, add reps.', [[30, 12], [35, 10], [40, '10-11'], [30, 12]]),
      P('Reverse Pec Deck', 'No 20 kg yet.', [[15, 15], [17.5, 12], [17.5, 12], [15, '12-15']]),
      P('Technogym Biceps Curl Machine', 'Tolerance test: log the pain score. Stop at 3/10.', [[null, 15], [null, 12], [null, '10-12']]),
    ] },
    d3: { dayId: 'd3', origin: 'starter', createdAt: Date.now(), generalNote: 'No recent targets on file yet. Your last logged session for this day becomes the template.', exercises: [
      P('Leg Press Machine', '', [[90, 15], [110, 15], [120, 15], [140, 15], [90, 15]]),
      P('Seated Calf Raises', '', [[40, 20], [60, 15], [80, 12], [80, 12]]),
      P('Standing Calf Raises', '', [[125, 15], [140, 13], [110, 15]]),
    ] },
  };
}
