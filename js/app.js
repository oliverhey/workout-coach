import { db, requestPersistence } from './db.js';
import {
  state, save, loadAll, uid, todayISO, fmtDate, daysAgo, dayById, doneSessions, draftSession, sessionsForDay,
  lastSessionForDay, num, e1rm, fmtW, fmtSet, topSet, maxPain, normName, allExerciseNames, lastPerformance,
  newSessionFromPlan, suggestNextDay, sortSessions, DEFAULT_SETTINGS, planDays,
  bandList, parseBand, fmtBand, bandLoad, bandHex, effW, isBandDay,
} from './store.js';
import { md, esc } from './md.js';
import { analyzeSession, adjustPlan, progressReport, MODELS, hasKey, AIError } from './ai.js';
import { lineChart } from './charts.js';
import { parseExport, splitPasted, runImport, resetImportProgress, mergeExercise } from './importer.js';
import { reviewPrompt, planChangePrompt, rebuildAllPrompt, reportPrompt, parseReview, parsePlanReply, parseRebuild } from './manual.js';

const $ = sel => document.querySelector(sel);
const view = $('#view');
const ui = { tab: 'train', detail: null, histFilter: 'all', progressEx: null, progressMode: 'ex' };
const running = new Set();   // session ids currently being analysed

// ---------------------------------------------------------------- utilities
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function modal(html, onMount) {
  const root = $('#modal-root');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  root.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  onMount && onMount(bg.querySelector('.modal'), close);
  return close;
}

function confirmDialog(title, text, ok = 'OK', danger = false) {
  return new Promise(resolve => {
    let done = false;
    const close = modal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="btn-row mt"><button class="btn grow" data-no>Cancel</button><button class="btn grow ${danger ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button></div>`,
    (m, c) => {
      m.querySelector('[data-yes]').onclick = () => { done = true; c(); resolve(true); };
      m.querySelector('[data-no]').onclick = () => { done = true; c(); resolve(false); };
    });
    const obs = new MutationObserver(() => { if (!document.contains(view) || done) return; if (!$('#modal-root').children.length) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe($('#modal-root'), { childList: true });
  });
}

const yymmdd = () => todayISO().slice(2).replace(/-/g, '');
const ratingPill = r => r == null ? '' : `<span class="pill ${r >= 8.5 ? 'good' : r >= 7 ? 'accent' : 'warn'} rating">${fmtW(r)}/10</span>`;

function topSetsLine(s, n = 3) {
  return (s.exercises || []).slice(0, n).map(ex => { const t = topSet(ex); return t ? `${esc(ex.name)} ${esc(fmtSet(t, { pain: false }))}` : null; }).filter(Boolean).join(' · ');
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad/.test(navigator.userAgent)) {
    navigator.share({ files: [file], title: filename }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const readFileText = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(f); });

// ---------------------------------------------------------------- render root
function render() {
  const draft = draftSession();
  const logging = ui.tab === 'train' && draft && !ui.detail;
  document.body.classList.toggle('logging', !!logging);
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const titles = { train: 'Train<span class="red">.</span>', history: 'History<span class="red">.</span>', progress: 'Progress<span class="red">.</span>', coach: 'Coach<span class="red">.</span>', settings: 'Settings<span class="red">.</span>' };
  $('#topbar-title').innerHTML = ui.detail ? 'Session<span class="red">.</span>' : logging ? 'Workout<span class="red">.</span>' : titles[ui.tab];

  if (ui.detail) return renderDetail(state.sessions.find(s => s.id === ui.detail));
  ({ train: renderTrain, history: renderHistory, progress: renderProgress, coach: renderCoach, settings: renderSettings })[ui.tab]();
}

function go(tab) { ui.tab = tab; ui.detail = null; render(); window.scrollTo(0, 0); }

// ---------------------------------------------------------------- TRAIN (home)
function renderTrain() {
  const draft = draftSession();
  if (draft) return renderLogger(draft);
  const next = suggestNextDay();
  const pending = doneSessions().filter(s => s.analysis && ['pending', 'error', 'manual'].includes(s.analysis.status)).slice(0, 3);
  const latest = doneSessions()[0];
  let html = '';

  if (!doneSessions().length) html += `<div class="card"><b>Bring over your history</b><div class="small muted mt">Import your ChatGPT data export so the coach knows your last 1.5 years.</div><button class="btn sm primary mt" data-action="open-import">Import ChatGPT export</button></div>`;
  for (const p of pending) {
    const st = running.has(p.id) ? '<span class="spinner"></span> Analysing…' : p.analysis.status === 'manual' ? '<span class="pill red">Get review</span>' : p.analysis.status === 'error' ? `<span class="pill bad">Failed</span>` : navigator.onLine ? '<span class="pill accent">Queued</span>' : '<span class="pill warn">Waiting for connection</span>';
    html += `<div class="card tap" data-open="${p.id}"><div class="row between"><div><b>${esc(p.title || dayById(p.dayId).name)}</b> <span class="muted small">${fmtDate(p.date, { day: 'numeric', month: 'short' })}</span></div><div class="row small">${st}</div></div>${p.analysis.status === 'error' ? `<div class="tiny muted mt">${esc(p.analysis.error || '')}</div>` : ''}</div>`;
  }

  if (latest && latest.analysis && latest.analysis.status === 'done' && ['claude', 'claude-app'].includes(latest.analysis.source) && daysAgo(latest.date) <= 2) {
    html += `<div class="card tap" data-open="${latest.id}"><div class="row between"><div class="small muted">Latest review · ${fmtDate(latest.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>${ratingPill(latest.analysis.rating)}</div><div class="mt">${esc(latest.analysis.headline || '')}</div></div>`;
  }

  view.innerHTML = html + weekHTML() + heroHTML(next) + otherDaysHTML(next);
}

// Monday-based week strip + streak of consecutive training weeks.
const isoOf = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
function mondayOf(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
function streakWeeks() {
  const dates = new Set(doneSessions().map(s => s.date));
  let wk = mondayOf(new Date()), n = 0;
  const has = w => { for (let i = 0; i < 7; i++) { const d = new Date(w); d.setDate(d.getDate() + i); if (dates.has(isoOf(d))) return true; } return false; };
  if (!has(wk)) wk.setDate(wk.getDate() - 7);
  while (has(wk)) { n++; wk.setDate(wk.getDate() - 7); }
  return n;
}
function weekHTML() {
  const mon = mondayOf(new Date()); const today = todayISO();
  const dates = new Set(doneSessions().map(s => s.date));
  let cells = '', count = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(d.getDate() + i); const iso = isoOf(d);
    const done = dates.has(iso); if (done) count++;
    cells += `<div class="d ${done ? 'done' : ''} ${iso === today ? 'today' : ''}"><div class="l">${'MTWTFSS'[i]}</div><div class="b">${d.getDate()}</div></div>`;
  }
  const streak = streakWeeks();
  return `<div class="streak"><div><div class="kicker">This week</div><div class="big">${count} workout${count === 1 ? '' : 's'}</div></div>
    <div style="text-align:right"><div class="kicker">Streak</div><div class="big">${streak} wk${streak === 1 ? '' : 's'}</div></div></div>
    <div class="week">${cells}</div>`;
}
function heroHTML(dayId) {
  const d = dayById(dayId); const plan = state.plans[dayId]; const last = lastSessionForDay(dayId);
  const exs = plan && plan.exercises && plan.exercises.length ? plan.exercises : last ? last.exercises.map(e => ({ name: e.name, sets: e.sets })) : [];
  const sets = exs.reduce((a, e) => a + (e.sets || []).filter(s => !s.wu).length, 0);
  const ago = last ? daysAgo(last.date) : null;
  return `<div class="hero"><div class="kicker">Up next</div>
    <div class="title">${esc(d.name)}</div>
    <div class="meta"><span><b>${exs.length}</b> exercises</span><span><b>${sets}</b> working sets</span>${last ? `<span>Last <b>${ago === 0 ? 'today' : ago + 'd ago'}</b></span>` : ''}</div>
    ${plan && plan.generalNote ? `<div class="coach-note">${esc(plan.generalNote)}</div>` : ''}
    <ol>${exs.map(e => { const top = (e.sets || []).filter(s => !s.wu && effW(s) != null).sort((a, b) => effW(b) - effW(a))[0]; return `<li><span>${esc(e.name)}</span><span class="t">${top ? (top.band ? bandDots(top.band) + `×${esc(top.r)}` : `${fmtW(top.w)}×${esc(top.r)}`) : ''}</span></li>`; }).join('')}</ol>
    <button class="btn primary block xl" data-start="${dayId}">Start workout</button>
    <button class="btn ghost block sm mt" data-plan="${dayId}">View / change plan</button></div>`;
}
function otherDaysHTML(next) {
  return `<h2>Other days</h2>` + state.days.filter(d => d.id !== next).map(d => {
    const last = lastSessionForDay(d.id); const ago = last ? daysAgo(last.date) : null;
    return `<div class="card day-row tap" data-start="${d.id}"><div class="sw" style="background:${d.color}"></div>
      <div class="grow"><div class="name">${esc(d.name)}</div><div class="tiny muted">${d.kind === 'free' && !last ? 'Off-cycle workout · starts empty' : d.kind === 'travel' && !last ? 'Travel workout with TRX & Bandit bands' : last ? `Last ${fmtDate(last.date, { day: 'numeric', month: 'short' })} · ${ago === 0 ? 'today' : ago + ' days ago'}${last.analysis && last.analysis.rating != null ? ` · ${fmtW(last.analysis.rating)}/10` : ''}` : 'No sessions yet'}</div></div>
      ${d.kind === 'free' ? '' : `<button class="btn sm" data-plan="${d.id}">Plan</button>`}<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg></div>`;
  }).join('');
}


// ---- resistance bands (TRX & Bands days)
function bandDots(band) {
  const o = parseBand(band); const keys = Object.keys(o);
  if (!keys.length) return esc(band || '–');
  return `<span class="bdots">${keys.map(k => `<span class="bdg"><b>${o[k]}</b><i style="background:${bandHex(k)}"></i></span>`).join('')}</span>`;
}
function bandPicker(s, ei, si) {
  const ex = s.exercises[ei]; const set = ex.sets[si];
  const counts = parseBand(set.band || (set.bw ? '' : set.tb) || '');
  const bands = bandList();
  for (const k of Object.keys(counts)) if (!bands.find(b => b.name === k)) bands.push({ name: k, value: 1, hex: bandHex(k) });
  modal(`<h3>Bands · set ${si + 1}</h3>
    <div class="small muted mb">${esc(ex.name)}${set.tb ? ` · target ${esc(set.tb)}` : ''}</div><div class="tiny dim mb" id="bp-kg"></div>
    ${bands.map(b => `<div class="band-row"><i style="background:${b.hex}"></i><span class="grow"><span class="cond" style="text-transform:uppercase;letter-spacing:.06em;font-weight:600">${esc(b.name)}</span><span class="tiny dim" style="margin-left:8px">${b.range ? esc(b.range) : `≈ ${fmtW(b.value)} kg`}</span></span>
      <button class="btn sm" data-bminus="${esc(b.name)}">−</button><span class="bcount num" data-bcount="${esc(b.name)}">${counts[b.name] || 0}</span><button class="btn sm" data-bplus="${esc(b.name)}">+</button></div>`).join('')}
    <label class="list-check" style="border:0"><input type="checkbox" id="bp-rest"><div class="small">Also use for the following sets of this exercise</div></label>
    <div class="btn-row mt"><button class="btn grow" id="bp-bw">No band (BW)</button><button class="btn primary grow" id="bp-ok">Done</button></div>`,
  (m, close) => {
    const upd = () => { m.querySelectorAll('[data-bcount]').forEach(el => { el.textContent = counts[el.dataset.bcount] || 0; }); const kg = bandLoad(fmtBand(counts)); m.querySelector('#bp-kg').textContent = kg ? `≈ ${fmtW(Math.round(kg * 10) / 10)} kg resistance` : ''; };
    upd();
    m.querySelectorAll('[data-bplus]').forEach(b => b.onclick = () => { counts[b.dataset.bplus] = (counts[b.dataset.bplus] || 0) + 1; upd(); });
    m.querySelectorAll('[data-bminus]').forEach(b => b.onclick = () => { counts[b.dataset.bminus] = Math.max(0, (counts[b.dataset.bminus] || 0) - 1); upd(); });
    const apply = (band, bw) => {
      const targets = m.querySelector('#bp-rest').checked ? ex.sets.slice(si) : [set];
      for (const t of targets) { t.band = band || null; t.bw = !band && bw; t.w = null; }
      save.session(s); close(); rerenderExercise(s, ei);
    };
    m.querySelector('#bp-ok').onclick = () => { const band = fmtBand(counts); apply(band, !band); };
    m.querySelector('#bp-bw').onclick = () => apply(null, true);
  });
}

// ---------------------------------------------------------------- LOGGER
let saveTimer;
function queueSave(s) { clearTimeout(saveTimer); saveTimer = setTimeout(() => save.session(s), 400); }

function painClass(p) { return p == null ? '' : p <= 2 ? 'p1' : p === 3 ? 'p2' : 'p3'; }

function setRowHTML(s, ei, si, prevSets = []) {
  const set = s.exercises[ei].sets[si];
  const workingIdx = s.exercises[ei].sets.slice(0, si + 1).filter(x => !x.wu).length;
  const opts = ['<option value="">–</option>', ...Array.from({ length: 11 }, (_, i) => `<option value="${i}" ${set.pain === i ? 'selected' : ''}>${i}</option>`)].join('');
  const prev = prevSets[si];
  const bandDay = isBandDay(s.dayId);
  const prevTxt = !prev ? '—' : prev.band ? bandDots(prev.band) : prev.bw || (bandDay && prev.w == null) ? `BW×${prev.r ?? '?'}` : esc(`${fmtW(prev.w)}×${prev.r ?? '?'}`);
  const loadCell = bandDay
    ? `<button class="bandbtn ${set.band || set.bw ? '' : 'ph'}" data-action="band-pick" aria-label="Bands">${set.band ? bandDots(set.band) : set.bw ? 'BW' : set.tb ? bandDots(set.tb) : '<span class="plus">+ band</span>'}</button>`
    : `<input inputmode="decimal" data-f="w" value="${set.w ?? ''}" placeholder="${set.tw != null ? fmtW(set.tw) : '–'}" aria-label="Weight">`;
  return `<div class="set-row grid ${set.done ? 'is-done' : ''}" data-ex="${ei}" data-set="${si}">
    <div class="idx ${set.wu ? 'wu' : ''}" data-action="toggle-wu" title="Tap to mark warm-up">${set.wu ? 'W' : workingIdx}</div>
    <div class="prev">${prevTxt}</div>
    ${loadCell}
    <input inputmode="numeric" data-f="r" value="${set.r ?? ''}" placeholder="${set.tr ?? '–'}" aria-label="Reps">
    <select data-f="pain" class="${painClass(set.pain)}" aria-label="Pain">${opts}</select>
    <button class="check ${set.done ? 'done' : ''}" data-action="check" aria-label="Set done"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></button>
  </div>`;
}

function exerciseHTML(s, ei) {
  const ex = s.exercises[ei];
  const last = lastPerformance(ex.name, s.date, s.id);
  const lastTxt = last ? `Last time · ${fmtDate(last.session.date, { day: 'numeric', month: 'short' })}${last.ex.userNote ? ' · ' + last.ex.userNote : ''}` : 'First time';
  const prevSets = last ? last.ex.sets : [];
  return `<div class="card ex-card" data-exi="${ei}">
    <div class="ex-head"><div class="ex-no">${String(ei + 1).padStart(2, '0')}</div><div class="grow"><div class="ex-title">${esc(ex.name)}</div><div class="ex-last ellipsis">${esc(lastTxt)}</div></div>
      <button class="icon-btn" data-action="ex-menu" data-ex="${ei}" aria-label="Exercise options"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button></div>
    ${ex.note ? `<div class="ex-note">${esc(ex.note)}</div>` : ''}
    <div class="legend grid"><span>Set</span><span>Prev</span><span>${isBandDay(s.dayId) ? 'Bands' : 'kg'}</span><span>Reps</span><span>Pain</span><span></span></div>
    ${ex.sets.map((_, si) => setRowHTML(s, ei, si, prevSets)).join('')}
    ${ex.userNote ? `<div class="small muted mt">Note: ${esc(ex.userNote)}</div>` : ''}
    <div class="ex-actions"><button class="btn sm ghost" data-action="del-set" data-ex="${ei}">− Remove set</button><button class="btn sm" data-action="add-set" data-ex="${ei}">+ Add set</button></div>
  </div>`;
}

function renderLogger(s) {
  const dayOpts = [...state.days, { id: 'other', name: 'Other' }].map(d => `<option value="${d.id}" ${d.id === s.dayId ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  view.innerHTML = `
    <div class="lg-head">
      <div class="kicker">${fmtDate(s.date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <div class="title">${esc(s.title || dayById(s.dayId).name)}</div>
      <div class="lg-meta">
        <input type="date" id="lg-date" value="${s.date}">
        <select id="lg-day">${dayOpts}</select>
        <input id="lg-bw" inputmode="decimal" placeholder="Body kg" value="${s.bodyweight ?? ''}" style="width:96px">
      </div>
    </div>
    ${s.planNote ? `<div class="coach-note">${esc(s.planNote)}</div>` : ''}
    <div class="tiny dim mb">Grey numbers are today's targets. Tap ✓ to log the set as planned, or type what you did, then ✓. Tap the set number to mark a warm-up.</div>
    <div id="ex-list">${s.exercises.map((_, i) => exerciseHTML(s, i)).join('')}</div>
    <button class="btn block mb" data-action="add-ex">+ Add exercise</button>
    <label class="field"><span>Session notes</span><textarea class="input" id="lg-notes" placeholder="Soreness, pain, machine changes, sleep…">${esc(s.notes || '')}</textarea></label>
    <div class="dock"><div class="inner">
      <div class="btn-row"><button class="btn" data-action="discard">Discard</button><button class="btn primary grow" data-action="finish">Finish workout</button></div>
    </div></div>`;

  $('#lg-date').onchange = e => { s.date = e.target.value || todayISO(); queueSave(s); };
  $('#lg-day').onchange = e => { s.dayId = e.target.value; s.title = dayById(s.dayId).name; queueSave(s); render(); };
  $('#lg-bw').oninput = e => { s.bodyweight = num(e.target.value); queueSave(s); };
  $('#lg-notes').oninput = e => { s.notes = e.target.value; queueSave(s); };
}

function rerenderExercise(s, ei) {
  const el = view.querySelector(`.ex-card[data-exi="${ei}"]`);
  if (el) el.outerHTML = exerciseHTML(s, ei); else render();
}

function loggerInput(e) {
  const s = draftSession(); if (!s) return;
  const row = e.target.closest('.set-row'); if (!row || !e.target.dataset.f) return;
  const ei = +row.dataset.ex, si = +row.dataset.set, f = e.target.dataset.f;
  const set = s.exercises[ei].sets[si];
  if (f === 'w') set.w = num(e.target.value);
  if (f === 'r') { const v = num(e.target.value); set.r = v == null ? null : Math.round(v); }
  if (f === 'pain') { set.pain = e.target.value === '' ? null : +e.target.value; e.target.className = painClass(set.pain); }
  queueSave(s);
}



async function loggerAction(action, btn) {
  const s = draftSession(); if (!s) return;
  const row = btn.closest('.set-row');
  const ei = row ? +row.dataset.ex : +btn.dataset.ex;
  const ex = s.exercises[ei];
  switch (action) {
    case 'check': {
      const set = ex.sets[+row.dataset.set];
      if (set.done) { set.done = false; }
      else {
        if (isBandDay(s.dayId)) { if (!set.band && !set.bw && set.tb) set.band = set.tb; }
        else if (set.w == null && set.tw != null) set.w = set.tw;
        if (set.r == null && set.tr) { const m = String(set.tr).match(/\d+/); if (m) set.r = +m[0]; }
        set.done = true;
      }
      rerenderExercise(s, ei); break;
    }
    case 'band-pick': return bandPicker(s, ei, +row.dataset.set);
    case 'toggle-wu': { const set = ex.sets[+row.dataset.set]; set.wu = !set.wu; rerenderExercise(s, ei); break; }
    case 'add-set': {
      const prev = ex.sets[ex.sets.length - 1];
      ex.sets.push({ w: null, r: null, pain: null, wu: false, done: false, tw: prev ? (prev.w ?? prev.tw) : null, tr: prev ? (prev.r != null ? String(prev.r) : prev.tr) : null, tb: prev ? (prev.band || prev.tb || null) : null });
      rerenderExercise(s, ei); break;
    }
    case 'del-set': { if (ex.sets.length) ex.sets.pop(); rerenderExercise(s, ei); break; }
    case 'ex-menu': return exerciseMenu(s, ei);
    case 'add-ex': return addExerciseDialog(s);
    case 'discard': {
      if (await confirmDialog('Discard this workout?', 'Everything logged in this session will be deleted.', 'Discard', true)) {
        state.sessions = state.sessions.filter(x => x.id !== s.id); await db.deleteSession(s.id); render();
      }
      return;
    }
    case 'finish': return finishDialog(s);
  }
  queueSave(s);
}

function exerciseMenu(s, ei) {
  const ex = s.exercises[ei];
  modal(`<h3>${esc(ex.name)}</h3>
    <label class="field"><span>Name</span><input class="input" id="em-name" value="${esc(ex.name)}" list="ex-names"></label>
    <datalist id="ex-names">${allExerciseNames().map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>
    <label class="field"><span>Your note for this exercise (pain, machine, feel)</span><textarea class="input" id="em-note">${esc(ex.userNote || '')}</textarea></label>
    <div class="btn-row mb"><button class="btn sm" id="em-up">↑ Move up</button><button class="btn sm" id="em-down">↓ Move down</button><button class="btn sm danger" id="em-del">Remove exercise</button></div>
    <div class="btn-row"><button class="btn grow" data-close>Cancel</button><button class="btn primary grow" id="em-save">Save</button></div>`,
  (m, close) => {
    m.querySelector('#em-save').onclick = () => { ex.name = m.querySelector('#em-name').value.trim() || ex.name; ex.userNote = m.querySelector('#em-note').value.trim(); save.session(s); close(); render(); };
    m.querySelector('#em-up').onclick = () => { if (ei > 0) { [s.exercises[ei - 1], s.exercises[ei]] = [s.exercises[ei], s.exercises[ei - 1]]; save.session(s); } close(); render(); };
    m.querySelector('#em-down').onclick = () => { if (ei < s.exercises.length - 1) { [s.exercises[ei + 1], s.exercises[ei]] = [s.exercises[ei], s.exercises[ei + 1]]; save.session(s); } close(); render(); };
    m.querySelector('#em-del').onclick = async () => { close(); if (await confirmDialog('Remove exercise?', `${ex.name} and its sets will be removed from this session.`, 'Remove', true)) { s.exercises.splice(ei, 1); save.session(s); render(); } };
  });
}

function addExerciseDialog(s) {
  modal(`<h3>Add exercise</h3>
    <label class="field"><span>Exercise</span><input class="input" id="ae-name" list="ex-names2" placeholder="Start typing…" autocomplete="off"></label>
    <datalist id="ex-names2">${allExerciseNames().map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>
    <label class="field"><span>Number of sets</span><input class="input" id="ae-sets" inputmode="numeric" value="3"></label>
    <div class="btn-row"><button class="btn grow" data-close>Cancel</button><button class="btn primary grow" id="ae-ok">Add</button></div>`,
  (m, close) => {
    m.querySelector('#ae-name').focus();
    m.querySelector('#ae-ok').onclick = () => {
      const name = m.querySelector('#ae-name').value.trim(); if (!name) return;
      const n = Math.max(1, Math.min(10, num(m.querySelector('#ae-sets').value) || 3));
      const last = lastPerformance(name, s.date, s.id);
      const sets = last ? last.ex.sets.map(x => ({ w: null, r: null, pain: null, wu: !!x.wu, done: false, tw: x.w, tr: x.r != null ? String(x.r) : null, tb: x.band || null }))
        : Array.from({ length: n }, () => ({ w: null, r: null, pain: null, wu: false, done: false, tw: null, tr: null }));
      s.exercises.push({ id: uid(), name, note: '', userNote: '', sets });
      save.session(s); close(); render();
      setTimeout(() => view.querySelector(`.ex-card[data-exi="${s.exercises.length - 1}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    };
  });
}

const isFlexDay = dayId => ['travel', 'free'].includes(dayById(dayId).kind);
function cleanSession(s) {
  for (const ex of s.exercises) ex.sets = ex.sets.filter(x => x.w != null || x.r != null);
  // TRX & Free sessions depend on available time: exercises without sets count as skipped, not as "not recorded".
  if (isFlexDay(s.dayId)) {
    const skipped = s.exercises.filter(ex => !ex.sets.length).map(ex => ex.name);
    s.skipped = [...new Set([...(s.skipped || []), ...skipped])];
    s.exercises = s.exercises.filter(ex => ex.sets.length);
  }
}

function finishDialog(s) {
  const logged = s.exercises.reduce((a, ex) => a + ex.sets.filter(x => x.w != null || x.r != null).length, 0);
  const empty = s.exercises.filter(ex => !ex.sets.some(x => x.w != null || x.r != null)).map(ex => ex.name);
  modal(`<h3>Finish workout</h3>
    <p class="muted">${logged} sets logged.${empty.length ? (isFlexDay(s.dayId) ? ` Skipped today: ${esc(empty.join(', '))}. That's fine for a ${esc(dayById(s.dayId).name)} session — the coach rates only what you did.` : ` No sets recorded for: ${esc(empty.join(', '))} (kept in the log as "not recorded").`) : ''} Empty target rows are dropped.</p>
    <p class="small muted">${s.finishedAt ? 'Your changes are saved. The existing review is kept; use "Re-run review" on the session page if you want a new one.' : hasKey() ? (navigator.onLine ? 'The coach will review it now and prepare your next session.' : 'You are offline: the review runs automatically once you are back online.') : 'Next you copy the session into the Claude app and paste the coach\'s reply back — the app then prepares your next session.'}</p>
    <div class="btn-row mt"><button class="btn grow" data-close>Keep logging</button><button class="btn primary grow" id="fin-ok">Finish</button></div>`,
  (m, close) => {
    m.querySelector('#fin-ok').onclick = async () => {
      cleanSession(s);
      const isEdit = !!s.finishedAt;   // editing an older session keeps its review; re-run it from the session page if wanted
      s.status = 'done'; s.finishedAt = s.finishedAt || Date.now();
      if (!isEdit) s.analysis = hasKey() ? { status: 'pending' } : { status: 'manual' };
      await save.session(s); sortSessions(); close();
      ui.tab = 'train'; ui.detail = s.id; render(); window.scrollTo(0, 0);
      runPending();
    };
  });
}

async function startSession(dayId) {
  if (draftSession()) return render();
  const s = newSessionFromPlan(dayId);
  state.sessions.unshift(s); await save.session(s); render(); window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- AI queue
async function runPending() {
  if (!hasKey() || !navigator.onLine) return;
  const list = doneSessions().filter(s => s.analysis && s.analysis.status === 'pending' && !running.has(s.id));
  for (const s of list) await analyse(s);
}

async function analyse(s) {
  if (running.has(s.id)) return;
  running.add(s.id); render();
  try {
    const { review, plan } = await analyzeSession(s);
    s.analysis = { status: 'done', source: 'claude', model: state.settings.model, rating: review.rating, headline: review.headline, markdown: review.review_markdown, summary: review.log_summary, at: Date.now() };
    await save.session(s);
    const latest = lastSessionForDay(s.dayId);
    if (s.dayId !== 'other' && latest && latest.id === s.id) {
      const prev = state.plans[s.dayId];
      state.plans[s.dayId] = { ...plan, prev: prev ? { ...prev, prev: undefined } : null };
      await save.plans();
    }
    toast(`Review ready: ${fmtW(review.rating)}/10`);
  } catch (err) {
    if (!navigator.onLine) s.analysis = { status: 'pending' };
    else s.analysis = { status: 'error', error: err.message };
    await save.session(s);
    if (!(err instanceof AIError) || navigator.onLine) toast(err.message, 4000);
  } finally {
    running.delete(s.id); render();
  }
}


// ---------------------------------------------------------------- FREE MODE (copy & paste via the Claude app)
const CLAUDE_URL = 'https://claude.ai/new';
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it into a new Claude chat'); return true; }
  catch (e) {
    modal(`<h3>Copy this prompt</h3><div class="small muted mb">Tap in the box, Select All, Copy — then paste it into a new Claude chat.</div>
      <textarea class="input" id="cp-fallback" style="min-height:300px;font-size:12px" readonly>${esc(text)}</textarea><button class="btn block mt" data-close>Done</button>`,
    m => { const t = m.querySelector('#cp-fallback'); t.focus(); t.select(); });
    return false;
  }
}
function manualSteps(id, what = 'prompt') {
  return `<div class="mstep"><div class="kicker">Step 1 · Ask Claude</div><div class="small mb">Copy the ${what} and paste it into a <b>new chat</b> in the Claude app.</div>
      <div class="btn-row"><button class="btn primary grow" id="${id}-copy">Copy for Claude</button><a class="btn" href="${CLAUDE_URL}" target="_blank" rel="noopener">Open Claude</a></div></div>
    <div class="mstep mt"><div class="kicker">Step 2 · Bring the answer back</div>
      <div class="small mb">Copy Claude's <b>whole answer</b> (copy icon below it) and tap <b>Paste answer</b>. The answer includes a JSON block at the end; that's the plan, and the app reads it automatically.</div>
      <div class="btn-row mb"><button class="btn primary grow" id="${id}-paste">Paste answer</button><label class="btn">Add file<input type="file" id="${id}-file" accept=".json,.txt,.md,application/json,text/plain,text/markdown" hidden></label></div>
      <div class="tiny dim mb">Claude made a separate file for the plan? Download it in the Claude app and add it with <b>Add file</b>. Pasting only the JSON works too.</div>
      <textarea class="input" id="${id}-reply" placeholder="Claude's answer appears here — you can also paste or type into this box" style="min-height:120px;font-size:13.5px"></textarea>
      <div class="small mt" id="${id}-status"></div>
      <button class="btn primary block mt" id="${id}-save">Save</button></div>`;
}
function wireManual(root, id, getPrompt, onSave) {
  const box = root.querySelector(`#${id}-reply`), status = root.querySelector(`#${id}-status`);
  const check = () => {
    const t = box.value.trim();
    if (!t) { status.innerHTML = ''; return; }
    const hasJson = /```(?:json)?[\s\S]*?"exercises"[\s\S]*?```/i.test(t) || /^\s*\{[\s\S]*"exercises"[\s\S]*\}\s*$/.test(t) || /"plans"\s*:/.test(t);
    const hasReview = /rating/i.test(t) || t.replace(/```[\s\S]*?```/g, '').trim().length > 80;
    status.innerHTML = [hasReview ? '<span class="pill good">Review text ✓</span>' : '<span class="pill warn">No review text</span>', hasJson ? '<span class="pill good">Plan (JSON) ✓</span>' : '<span class="pill warn">No plan JSON — add the file if Claude made one</span>'].join(' ');
  };
  const add = text => { text = String(text || '').trim(); if (!text) return; box.value = (box.value.trim() ? box.value.trim() + '\n\n' : '') + (/^\s*[\[{]/.test(text) ? '```json\n' + text + '\n```' : text); check(); };
  box.addEventListener('input', check);
  root.querySelector(`#${id}-copy`).onclick = () => copyText(getPrompt());
  root.querySelector(`#${id}-paste`).onclick = async () => {
    try { const t = await navigator.clipboard.readText(); if (!t.trim()) return toast('Clipboard is empty — copy Claude\'s answer first'); add(t); }
    catch (e) { toast('Tap the box and paste manually'); box.focus(); }
  };
  root.querySelector(`#${id}-file`).onchange = async e => { const f = e.target.files[0]; if (!f) return; add(await readFileText(f)); e.target.value = ''; toast('File added'); };
  root.querySelector(`#${id}-save`).onclick = async () => {
    const text = box.value.trim();
    if (!text) return toast('Paste Claude\'s answer first');
    try { await onSave(text); } catch (err) { toast(err.message, 5000); }
  };
}
function manualReviewHTML(s) {
  return `<div class="card" id="mr-box"><div class="kicker">Coach review</div><div class="cond" style="font-size:20px;font-weight:700;text-transform:uppercase;margin:4px 0 12px">Get it from the Claude app</div>
    ${manualSteps('mr', 'session')}
    ${s.analysis.prev ? '<button class="btn sm ghost mt" data-action="keep-review" data-id="' + s.id + '">Keep the previous review</button>' : ''}</div>`;
}
async function saveManualReview(s, text) {
  const r = parseReview(text, s.dayId, s.id);
  s.analysis = { status: 'done', source: 'claude-app', rating: r.rating, headline: r.headline, markdown: r.markdown, summary: r.summary, at: Date.now() };
  await save.session(s);
  const latest = lastSessionForDay(s.dayId);
  if (r.plan && s.dayId !== 'other' && latest && latest.id === s.id) {
    const prev = state.plans[s.dayId];
    state.plans[s.dayId] = { ...r.plan, prev: prev ? { ...prev, prev: undefined } : null };
    await save.plans();
    toast(`Saved${r.rating != null ? ` — ${fmtW(r.rating)}/10` : ''}. Next ${dayById(s.dayId).name} is ready.`, 3500);
  } else if (!r.plan) toast('Review saved, but no plan was found in the reply — your next plan is unchanged.', 5000);
  else toast('Review saved.');
  render(); window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- SESSION DETAIL
function sessionStats(s) {
  let volume = 0, sets = 0, reps = 0; const prs = [];
  for (const ex of s.exercises || []) {
    for (const x of ex.sets) if (!x.wu && x.r != null) { reps += x.r; sets++; if (x.w != null) volume += x.w * x.r; }
    const t = topSet(ex); if (!t) continue;
    const k = normName(ex.name); let prior = 0, seen = false;
    for (const o of doneSessions()) {
      if (o.id === s.id || o.date >= s.date) continue;
      const oe = (o.exercises || []).find(e => normName(e.name) === k); if (!oe) continue;
      const ot = topSet(oe); if (ot) { seen = true; prior = Math.max(prior, e1rm(effW(ot), ot.r)); }
    }
    if (seen && e1rm(effW(t), t.r) > prior + 0.01) prs.push(k);
  }
  const dur = s.source !== 'import' && s.finishedAt && s.startedAt ? (s.finishedAt - s.startedAt) / 60000 : null;
  return { volume, reps, sets, prs, minutes: dur && dur > 3 && dur < 300 ? Math.round(dur) : null };
}
function renderDetail(s) {
  if (!s) { ui.detail = null; return render(); }
  document.body.classList.remove('logging');
  const d = dayById(s.dayId);
  const a = s.analysis;
  let analysisHTML = '';
  if (running.has(s.id)) analysisHTML = `<div class="card row"><span class="spinner"></span><div>The coach is reviewing this session…</div></div>`;
  else if (a && a.status === 'manual') analysisHTML = manualReviewHTML(s);
  else if (!a) analysisHTML = `<div class="card"><div class="muted small">No review yet.</div><button class="btn sm primary mt" data-action="reanalyse" data-id="${s.id}">Review this session</button></div>`;
  else if (a.status === 'pending') analysisHTML = `<div class="card"><span class="pill warn">${navigator.onLine ? 'Queued' : 'Waiting for connection'}</span><div class="small muted mt">The review runs automatically when you are online.</div></div>`;
  else if (a.status === 'error') analysisHTML = `<div class="card"><span class="pill bad">Review failed</span><div class="small muted mt">${esc(a.error || '')}</div><button class="btn sm primary mt" data-action="reanalyse" data-id="${s.id}">Try again</button></div>`;
  else analysisHTML = `<div class="card"><div class="score mb"><div class="big">${a.rating != null ? fmtW(a.rating) : '–'}<small>/10</small></div><div class="grow"><div class="kicker">${a.source === 'chatgpt' ? 'Imported ChatGPT review' : 'Coach rating'}</div>${a.headline ? `<div class="cond" style="font-size:18px;font-weight:600;line-height:1.25;margin-top:4px">${esc(a.headline)}</div>` : ''}</div></div><div class="md">${md(a.markdown || '')}</div></div>`;

  const plan = state.plans[s.dayId];
  const planLink = plan && plan.sourceSessionId === s.id ? `<button class="btn primary block mb" data-plan="${s.dayId}">See next ${esc(d.name)} plan →</button>` : '';
  const st = sessionStats(s);
  const fresh = s.finishedAt && Date.now() - s.finishedAt < 6 * 3600 * 1000 && s.source !== 'import';

  view.innerHTML = `
    <button class="btn sm ghost" data-action="back" style="padding-left:0">← Back</button>
    <div class="done-hero">
      <div class="kicker">${fmtDate(s.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${s.source === 'import' ? ' · imported' : ''}</div>
      <div class="title">${fresh ? `Workout<br><span class="red">complete.</span>` : esc(s.title || d.name)}</div>
      ${fresh ? `<div class="cond muted" style="text-transform:uppercase;letter-spacing:.1em;margin-top:6px">${esc(s.title || d.name)}</div>` : ''}
    </div>
    <div class="stats">
      ${isBandDay(s.dayId) ? `<div><div class="v">${st.reps.toLocaleString('en-GB')}</div><div class="l">Total reps</div></div>` : `<div><div class="v">${Math.round(st.volume).toLocaleString('en-GB')}<small>kg</small></div><div class="l">Total lifted</div></div>`}
      <div><div class="v">${st.sets}</div><div class="l">Working sets</div></div>
      <div><div class="v">${st.minutes != null ? st.minutes + '<small>min</small>' : '–'}</div><div class="l">Duration</div></div>
      <div><div class="v" style="${st.prs.length ? 'color:var(--red-2)' : ''}">${st.prs.length}</div><div class="l">New bests</div></div>
    </div>
    ${analysisHTML}
    ${planLink}
    <h2>Logged</h2>
    <div class="card">${(s.exercises || []).map(ex => `<div class="ex-sum"><div class="n">${esc(ex.name)}${st.prs.includes(normName(ex.name)) ? '<span class="pr">New best</span>' : ''}</div><div class="set-list">${ex.sets.length ? ex.sets.map(x => `<b>${esc(fmtSet(x, { pain: false }))}</b>${x.pain != null ? `<span class="${x.pain >= 3 ? 'pill bad' : 'dim'}" style="margin-left:4px">${x.pain}/10</span>` : ''}`).join('<span class="dim"> · </span>') : '<span class="dim">not recorded</span>'}</div>${ex.userNote ? `<div class="small muted">Note: ${esc(ex.userNote)}</div>` : ''}</div>`).join('')}
      ${s.skipped && s.skipped.length ? `<div class="small muted mt">Skipped (time): ${esc(s.skipped.join(', '))}</div>` : ''}
      ${s.notes ? `<div class="small muted mt">Session notes: ${esc(s.notes)}</div>` : ''}${s.bodyweight ? `<div class="small muted">Body weight: ${fmtW(s.bodyweight)} kg</div>` : ''}</div>
    <div class="btn-row mt">
      ${a && a.status === 'done' ? `<button class="btn sm" data-action="reanalyse" data-id="${s.id}">Re-run review</button>` : ''}
      <button class="btn sm" data-action="edit-session" data-id="${s.id}">Edit</button>
      <button class="btn sm danger" data-action="delete-session" data-id="${s.id}">Delete</button>
    </div>`;
  if (a && a.status === 'manual') wireManual(view, 'mr', () => reviewPrompt(s), text => saveManualReview(s, text));
}

// ---------------------------------------------------------------- HISTORY
function renderHistory() {
  const f = ui.histFilter;
  const list = doneSessions().filter(s => f === 'all' || s.dayId === f);
  const seg = `<div class="seg">${[{ id: 'all', name: 'All' }, ...state.days].map(d => `<button data-hist="${d.id}" class="${f === d.id ? 'active' : ''}">${esc(d.kind === 'travel' ? 'TRX' : d.name.split(' & ')[0])}</button>`).join('')}</div>`;
  if (!list.length) { view.innerHTML = seg + `<div class="empty">No sessions yet.<br><button class="btn sm mt" data-action="open-import">Import ChatGPT history</button></div>`; return; }
  let html = seg, month = '';
  for (const s of list.slice(0, 400)) {
    const m = s.date.slice(0, 7);
    if (m !== month) { month = m; html += `<h2>${fmtDate(m + '-01', { month: 'long', year: 'numeric' })}</h2>`; }
    const d = dayById(s.dayId);
    html += `<div class="card tap hist-item" data-open="${s.id}" style="border-left:3px solid ${d.color}">
      <div class="date"><div class="dn">${+s.date.slice(8)}</div><div class="dw">${fmtDate(s.date, { weekday: 'short' })}</div></div>
      <div class="grow" style="min-width:0"><div class="t ellipsis">${esc(s.title || d.name)}</div><div class="sum ellipsis">${topSetsLine(s) || '—'}</div></div>
      ${s.analysis && s.analysis.rating != null ? `<div class="rating" style="font-size:20px">${fmtW(s.analysis.rating)}</div>` : s.analysis && s.analysis.status === 'pending' ? '<span class="pill warn">Queued</span>' : ''}</div>`;
  }
  if (list.length > 400) html += `<div class="center small muted">Showing the latest 400 of ${list.length}.</div>`;
  view.innerHTML = html;
}

// ---------------------------------------------------------------- PROGRESS
function renderProgress() {
  const sessions = doneSessions();
  const seg = `<div class="seg"><button data-pmode="ex" class="${ui.progressMode === 'ex' ? 'active' : ''}">Exercises</button><button data-pmode="overview" class="${ui.progressMode === 'overview' ? 'active' : ''}">Overview</button></div>`;
  if (!sessions.length) { view.innerHTML = seg + '<div class="empty">Log or import sessions to see progress.</div>'; return; }
  if (ui.progressMode === 'overview') return renderOverview(seg, sessions);

  const names = allExerciseNames().filter(x => x.count > 0).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  if (!ui.progressEx || !names.find(n => normName(n.name) === normName(ui.progressEx))) ui.progressEx = names[0] && names[0].name;
  const k = normName(ui.progressEx);
  const pts = [];
  let mode = 'kg';
  for (const s of [...sessions].reverse()) {
    const ex = (s.exercises || []).find(e => normName(e.name) === k); if (!ex) continue;
    const [y, m, d] = s.date.split('-').map(Number);
    const x = new Date(y, m - 1, d).getTime();
    const work = ex.sets.filter(z => !z.wu && z.r != null);
    if (!work.length) continue;
    const t = topSet(ex);
    if (t && t.band) mode = 'band';
    pts.push({ x, date: s.date, w: t ? effW(t) : null, label: t ? (t.band || fmtW(t.w)) : 'BW', r: t ? t.r : Math.max(...work.map(z => z.r)),
      e: t ? e1rm(effW(t), t.r) : null, maxR: Math.max(...work.map(z => z.r)), totR: work.reduce((a, z) => a + z.r, 0), pain: maxPain(ex), sets: ex.sets, id: s.id });
  }
  if (pts.length && pts.every(p => p.w == null)) mode = 'reps';
  const lp = pts.filter(p => p.e != null);
  const best = lp.reduce((a, p) => (!a || p.e > a.e ? p : a), null);
  const heaviest = lp.reduce((a, p) => (!a || p.w > a.w || (p.w === a.w && p.r > a.r) ? p : a), null);
  const first = lp[0], last = lp[lp.length - 1];
  const painPts = pts.filter(p => p.pain != null);
  const painSeries = painPts.length ? [{ name: 'Max pain (0–10, right axis)', color: '#f2a531', right: true, points: painPts.map(p => ({ x: p.x, y: p.pain, label: `${p.date}: pain ${p.pain}/10` })) }] : [];
  const unit = mode === 'band' ? 'kg, est.' : 'kg';
  const chart = mode === 'reps'
    ? lineChart([
        { name: 'Best set (reps)', color: '#ff3b3f', points: pts.map(p => ({ x: p.x, y: p.maxR, label: `${p.date}: ${p.maxR} reps` })) },
        { name: 'Total reps', color: '#f4f1ea', dashed: true, points: pts.map(p => ({ x: p.x, y: p.totR, label: `${p.date}: ${p.totR} reps` })) },
        ...painSeries], { height: 220, yMin: 0, rightAxis: painPts.length ? { min: 0, max: 10 } : null })
    : lineChart([
        { name: mode === 'band' ? 'Est. 1RM (kg, from band resistance)' : 'Est. 1RM (kg)', color: '#ff3b3f', points: lp.map(p => ({ x: p.x, y: p.e, label: `${p.date}: ${p.label}×${p.r} → ${p.e.toFixed(1)}` })) },
        { name: `Top-set load (${unit})`, color: '#f4f1ea', dashed: true, points: lp.map(p => ({ x: p.x, y: p.w, label: `${p.date}: ${p.label}×${p.r}` })) },
        ...painSeries], { height: 220, rightAxis: painPts.length ? { min: 0, max: 10 } : null });
  const statsHTML = mode === 'reps'
    ? `<div class="stat"><div class="v">${Math.max(...pts.map(p => p.maxR))}</div><div class="l">Best set (reps)</div></div>
       <div class="stat"><div class="v">${pts[pts.length - 1].totR}</div><div class="l">Total reps last time</div></div>
       <div class="stat"><div class="v">${pts.length}</div><div class="l">Sessions</div></div>`
    : `<div class="stat"><div class="v">${best ? best.e.toFixed(0) : '–'}</div><div class="l">${mode === 'band' ? 'Best est. 1RM (kg)' : 'Best est. 1RM'}</div></div>
       <div class="stat"><div class="v" style="${mode === 'band' ? 'font-size:18px' : ''}">${heaviest ? (mode === 'band' ? bandDots(heaviest.label) + '×' + heaviest.r : `${fmtW(heaviest.w)}×${heaviest.r}`) : '–'}</div><div class="l">Heaviest top set</div></div>
       <div class="stat"><div class="v">${first && last && first !== last ? `${last.e - first.e >= 0 ? '+' : ''}${Math.round((last.e / first.e - 1) * 100)}%` : '–'}</div><div class="l">${mode === 'band' ? 'Change since first' : '1RM since first'}</div></div>`;
  view.innerHTML = seg + `
    <label class="field"><span>Exercise</span><select class="input" id="pg-ex">${names.map(n => `<option ${normName(n.name) === k ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select></label>
    <div class="stat-grid">${statsHTML}
    </div>
    <div class="card">${chart}${mode === 'band' ? '<div class="tiny dim mt">Band kg are estimates: each band counts at the middle of its resistance range (Settings → TRX Bandit bands).</div>' : ''}</div>
    <h2>Recent sessions</h2>
    <div class="card">${pts.slice(-12).reverse().map(p => `<div class="row between tap" data-open="${p.id}" style="padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer"><span class="small muted">${fmtDate(p.date, { day: 'numeric', month: 'short', year: '2-digit' })}</span><span class="small ellipsis grow" style="text-align:right">${p.sets.filter(x => !x.wu).map(x => fmtSet(x)).join(' · ')}</span></div>`).join('')}</div>`;
  $('#pg-ex').onchange = e => { ui.progressEx = e.target.value; render(); };
}

function renderOverview(seg, sessions) {
  const now = new Date();
  const since = n => sessions.filter(s => daysAgo(s.date) <= n).length;
  const rated = sessions.filter(s => s.analysis && s.analysis.rating != null).slice(0, 10);
  const avg = rated.length ? rated.reduce((a, s) => a + s.analysis.rating, 0) / rated.length : null;
  const toX = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const bw = sessions.filter(s => s.bodyweight).map(s => ({ x: toX(s.date), y: s.bodyweight, label: `${s.date}: ${s.bodyweight} kg` }));
  // sessions per 4-week block
  const weeks = [];
  for (let i = 25; i >= 0; i--) {
    const end = new Date(now); end.setDate(end.getDate() - i * 14);
    const start = new Date(end); start.setDate(start.getDate() - 14);
    const n = sessions.filter(s => { const t = toX(s.date); return t > start.getTime() && t <= end.getTime(); }).length;
    weeks.push({ x: end.getTime(), y: n / 2, label: `${(n / 2).toFixed(1)} sessions/week` });
  }
  const ratings = sessions.filter(s => s.analysis && s.analysis.rating != null).map(s => ({ x: toX(s.date), y: s.analysis.rating, label: `${s.date}: ${s.analysis.rating}/10` }));
  view.innerHTML = seg + `
    <div class="stat-grid">
      <div class="stat"><div class="v">${sessions.length}</div><div class="l">Sessions logged</div></div>
      <div class="stat"><div class="v">${since(30)}</div><div class="l">Last 30 days</div></div>
      <div class="stat"><div class="v">${avg != null ? avg.toFixed(1) : '–'}</div><div class="l">Avg rating (last 10)</div></div>
    </div>
    <h2>Training frequency (sessions per week, 2-week blocks)</h2>
    <div class="card">${lineChart([{ name: 'Sessions/week', color: '#f4f1ea', points: weeks }], { height: 170, yMin: 0 })}</div>
    <h2>Session ratings</h2>
    <div class="card">${lineChart([{ name: 'Rating', color: '#ff3b3f', points: ratings }], { height: 170, yMin: 0, yMax: 10 })}</div>
    <h2>Body weight</h2>
    <div class="card">${bw.length ? lineChart([{ name: 'Body weight (kg)', color: '#f2a531', points: bw }], { height: 170 }) : '<div class="small muted">Enter your body weight in the logger header (optional) to track the fat-loss side of your goal here.</div>'}</div>
    <button class="btn block primary mt" data-go="coach">Get a progress report from the coach →</button>`;
}

// ---------------------------------------------------------------- COACH
function planHTML(p) {
  if (!p || !p.exercises || !p.exercises.length) return '<div class="small muted">No plan yet.</div>';
  return `${p.generalNote ? `<div class="coach-note">${esc(p.generalNote)}</div>` : ''}${p.exercises.map((e, i) => `<div class="plan-ex"><div class="n"><span style="color:var(--red-2);margin-right:8px">${String(i + 1).padStart(2, '0')}</span>${esc(e.name)}</div><div class="set-list">${e.sets.map(s => `${s.wu ? 'wu ' : ''}<b>${s.band ? esc(s.band) : s.w == null ? (s.bw ? 'BW' : '?') : fmtW(s.w)}×${esc(s.r)}</b>`).join('<span class="dim"> · </span>')}</div>${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</div>`).join('')}`;
}

function renderCoach() {
  const sixMonthsAgo = (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); })();
  let html = `<h2>Next session plans</h2>`;
  for (const d of planDays()) {
    const p = state.plans[d.id];
    html += `<div class="card" style="border-left:3px solid ${d.color}">
      <div class="row between"><h3>${esc(d.name)}</h3><span class="tiny dim">${p ? (p.origin === 'starter' ? 'starter plan' : p.origin === 'manual' ? 'edited' : 'from coach · ' + new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })) : ''}</span></div>
      <div class="btn-row mt"><button class="btn sm" data-plan="${d.id}">View</button><button class="btn sm primary" data-change-plan="${d.id}">Change plan…</button>${p && p.prev ? `<button class="btn sm ghost" data-undo-plan="${d.id}">Undo last change</button>` : ''}</div></div>`;
  }
  html += `<h2>Progress report</h2>
    <div class="card">
      <div class="row"><label class="field grow"><span>From</span><input type="date" class="input" id="rp-from" value="${sixMonthsAgo}"></label><label class="field grow"><span>To</span><input type="date" class="input" id="rp-to" value="${todayISO()}"></label></div>
      <label class="field"><span>Anything specific? (optional)</span><input class="input" id="rp-focus" placeholder="e.g. is my chest keeping up with back?"></label>
      <button class="btn primary block" id="rp-go">Generate report</button>
    </div>`;
  if (state.reports.length) {
    html += `<h2>Saved reports</h2>` + state.reports.map(r => `<div class="card tap" data-report="${r.id}"><div class="row between"><b>${fmtDate(r.from, { month: 'short', year: 'numeric' })} – ${fmtDate(r.to, { month: 'short', year: 'numeric' })}</b><span class="small muted">${new Date(r.at).toLocaleDateString('en-GB')}</span></div>${r.focus ? `<div class="small muted ellipsis">${esc(r.focus)}</div>` : ''}</div>`).join('');
  }
  view.innerHTML = html;
  $('#rp-go').onclick = async e => {
    const btn = e.currentTarget;
    const from = $('#rp-from').value, to = $('#rp-to').value, focus = $('#rp-focus').value.trim();
    if (!hasKey()) {
      const pr = reportPrompt(from, to, focus);
      if (!pr.count) return toast('No sessions in that period');
      modal(`<div class="row between"><h3>Progress report</h3><button class="icon-btn" data-close>✕</button></div><div class="small muted mb">${pr.count} sessions, ${fmtDate(from)} – ${fmtDate(to)}</div>${manualSteps('rpm', 'sessions')}`,
      (m, close) => wireManual(m, 'rpm', () => pr.text, async text => {
        const r = { id: uid(), from, to, focus, at: Date.now(), markdown: text };
        state.reports.unshift(r); await save.reports(); close(); render(); openReport(r.id);
      }));
      return;
    }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Writing report…';
    try {
      const text = await progressReport(from, to, focus);
      const r = { id: uid(), from, to, focus, at: Date.now(), markdown: text };
      state.reports.unshift(r); await save.reports();
      render(); openReport(r.id);
    } catch (err) { toast(err.message, 4500); btn.disabled = false; btn.textContent = 'Generate report'; }
  };
}

function openReport(id) {
  const r = state.reports.find(x => x.id === id); if (!r) return;
  modal(`<div class="row between"><h3>Progress report</h3><button class="icon-btn" data-close>✕</button></div>
    <div class="small muted mb">${fmtDate(r.from)} – ${fmtDate(r.to)}</div><div class="md">${md(r.markdown)}</div>
    <div class="btn-row mt"><button class="btn sm danger" id="rp-del">Delete report</button><button class="btn sm" id="rp-copy">Copy text</button></div>`,
  (m, close) => {
    m.querySelector('#rp-copy').onclick = () => navigator.clipboard.writeText(r.markdown).then(() => toast('Copied'));
    m.querySelector('#rp-del').onclick = async () => { close(); if (await confirmDialog('Delete report?', 'This report will be removed.', 'Delete', true)) { state.reports = state.reports.filter(x => x.id !== id); await save.reports(); render(); } };
  });
}

function showPlan(dayId) {
  const d = dayById(dayId);
  modal(`<div class="row between"><h3>Next ${esc(d.name)}</h3><button class="icon-btn" data-close>✕</button></div>${planHTML(state.plans[dayId])}
    <div class="btn-row mt"><button class="btn grow" id="sp-edit">Edit manually</button><button class="btn primary grow" id="sp-change">Ask coach to change</button></div>`,
  (m, close) => {
    m.querySelector('#sp-change').onclick = () => { close(); changePlanDialog(dayId); };
    m.querySelector('#sp-edit').onclick = () => { close(); editPlanDialog(dayId); };
  });
}

function planToEditable(p) {
  return (p && p.exercises || []).map(e => `${e.name}: ${e.sets.map(s => `${s.wu ? 'wu ' : ''}${s.band ? s.band : s.w == null ? (s.bw ? 'bw' : '?') : fmtW(s.w)}x${s.r}`).join(', ')}${e.note ? ` | ${e.note}` : ''}`).join('\n');
}

function parseEditable(text, dayId, old) {
  const exercises = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*([^|]*)(?:\|\s*(.*))?$/); if (!m) continue;
    const sets = m[2].split(',').map(x => x.trim()).filter(Boolean).map(x => {
      const wu = /^wu\s+/i.test(x); x = x.replace(/^wu\s+/i, '');
      const mm = x.match(/^(.+?)\s*[x×]\s*([\d\-–]+)\s*$/i);
      if (!mm) return null;
      const left = mm[1].trim(), r = mm[2].replace('–', '-');
      if (/^[\d.,]+$/.test(left)) return { w: num(left), r, wu };
      if (left === '?') return { w: null, r, wu };
      if (/^bw$/i.test(left)) return { w: null, r, wu, bw: true };
      const band = fmtBand(parseBand(left)); return band ? { w: null, band, r, wu } : null;
    }).filter(Boolean);
    exercises.push({ name: m[1].trim(), note: (m[3] || '').trim(), sets });
  }
  return { dayId, origin: 'manual', createdAt: Date.now(), generalNote: old ? old.generalNote : '', exercises, sourceSessionId: old ? old.sourceSessionId : null };
}

function editPlanDialog(dayId) {
  const old = state.plans[dayId];
  modal(`<h3>Edit ${esc(dayById(dayId).name)} plan</h3>
    <div class="small muted mb">One exercise per line: <code>Name: 60x10, 70x8-10 | note</code>. Prefix warm-ups with <code>wu</code>; use <code>?</code> for unknown weight.</div>
    <textarea class="input" id="ep-text" style="min-height:260px;font-size:14px">${esc(planToEditable(old))}</textarea>
    <label class="field mt"><span>Focus note</span><input class="input" id="ep-note" value="${esc(old ? old.generalNote : '')}"></label>
    <div class="btn-row"><button class="btn grow" data-close>Cancel</button><button class="btn primary grow" id="ep-save">Save plan</button></div>`,
  (m, close) => {
    m.querySelector('#ep-save').onclick = async () => {
      const p = parseEditable(m.querySelector('#ep-text').value, dayId, old);
      p.generalNote = m.querySelector('#ep-note').value.trim();
      if (!p.exercises.length) return toast('No exercises recognised');
      state.plans[dayId] = { ...p, prev: old ? { ...old, prev: undefined } : null };
      await save.plans(); close(); render(); toast('Plan saved');
    };
  });
}

function changePlanDialog(dayId) {
  const d = dayById(dayId);
  const chips = ['Substitute an exercise that keeps causing pain', 'Change the exercise order', 'Freshen up the whole plan with some new exercises', 'Make it fit in 45 minutes', 'Rebuild the next session from my latest history'];
  modal(`<h3>Change ${esc(d.name)} plan</h3>
    <div class="btn-row mb">${chips.map(c => `<button class="btn sm" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <label class="field"><span>What should the coach change?</span><textarea class="input" id="cp-req" placeholder="e.g. swap the incline machine press for something kinder to my shoulder"></textarea></label>
    <div class="btn-row"><button class="btn grow" data-close>Cancel</button><button class="btn primary grow" id="cp-go">Ask coach</button></div>`,
  (m, close) => {
    m.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { m.querySelector('#cp-req').value = b.dataset.chip; });
    m.querySelector('#cp-go').onclick = async e => {
      const req = m.querySelector('#cp-req').value.trim(); if (!req) return;
      if (!hasKey()) {
        m.innerHTML = `<div class="row between"><h3>Change ${esc(d.name)} plan</h3><button class="icon-btn" id="cpm-x">✕</button></div><div class="small muted mb">Request: ${esc(req)}</div>${manualSteps('cpm')}`;
        m.querySelector('#cpm-x').onclick = close;
        wireManual(m, 'cpm', () => planChangePrompt(dayId, req), async text => { const { explanation, plan } = parsePlanReply(text, dayId); close(); proposePlan(dayId, plan, explanation); });
        return;
      }
      const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Thinking…';
      try {
        const { explanation, plan } = await adjustPlan(dayId, req);
        close(); proposePlan(dayId, plan, explanation);
      } catch (err) { toast(err.message, 4500); btn.disabled = false; btn.textContent = 'Ask coach'; }
    };
  });
}

function proposePlan(dayId, plan, explanation) {
  modal(`<h3>Proposed ${esc(dayById(dayId).name)} plan</h3><div class="md mb">${md(explanation)}</div><div class="card">${planHTML(plan)}</div>
    <div class="btn-row"><button class="btn grow" data-close>Keep current plan</button><button class="btn primary grow" id="pp-ok">Use this plan</button></div>`,
  (m, close) => {
    m.querySelector('#pp-ok').onclick = async () => {
      const old = state.plans[dayId];
      state.plans[dayId] = { ...plan, prev: old ? { ...old, prev: undefined } : null };
      await save.plans(); close(); render(); toast('Plan updated');
    };
  });
}

// ---------------------------------------------------------------- SETTINGS
function renderSettings() {
  const s = state.settings;
  const persisted = state._persisted ? '<span class="pill good">Storage protected</span>' : '<span class="pill warn">Add to Home Screen to protect storage</span>';
  view.innerHTML = `
    <h2>Claude coach</h2>
    <div class="card">
      <div class="small mb">${hasKey() ? '<span class="pill good">Automatic mode</span> Reviews run in the background via the API.' : '<span class="pill red">Free mode</span> No key: after each workout you copy the session into the Claude app and paste the reply back. Covered by your Claude plan.'}</div>
      <label class="field"><span>Anthropic API key (optional, paid separately)</span><input class="input" id="st-key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(s.apiKey)}"></label>
      <div class="small muted mb">Stored only on this device and sent only to api.anthropic.com. Create one at console.anthropic.com → API Keys.</div>
      <label class="field"><span>Model</span><select class="input" id="st-model">${MODELS.map(m => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.label}</option>`).join('')}${MODELS.find(m => m.id === s.model) ? '' : `<option selected value="${esc(s.model)}">${esc(s.model)}</option>`}</select></label>
      <label class="field"><span>Custom model ID (optional, overrides the list)</span><input class="input" id="st-model-custom" placeholder="e.g. claude-sonnet-5-5" value=""></label>
      <div class="small muted">Tokens used so far: ${state.usage.input.toLocaleString()} in / ${state.usage.output.toLocaleString()} out</div>
    </div>
    <h2>Coaching profile</h2>
    <div class="card">
      <label class="field"><span>Goal</span><textarea class="input" id="st-goal">${esc(s.goal)}</textarea></label>
      <label class="field"><span>Standing rules (one per line)</span><textarea class="input" id="st-rules" style="min-height:150px">${esc(s.rules)}</textarea></label>
      <label class="field"><span>Coaching style</span><textarea class="input" id="st-style">${esc(s.coachStyle)}</textarea></label>
      <label class="field"><span>TRX Bandit bands (one per line: colour = kg at mid-stretch, range optional)</span><textarea class="input" id="st-bands" style="min-height:70px">${esc(s.bands || '')}</textarea></label>
      <label class="field"><span>Previous sessions of the same day sent with each review</span><input class="input" id="st-depth" inputmode="numeric" value="${s.historyDepth}"></label>
    </div>
    <h2>Split days</h2>
    <div class="card">${state.days.map((d, i) => `<div class="row mb"><input type="color" value="${d.color}" data-daycolor="${i}" style="width:40px;height:40px;border:0;background:none;padding:0"><input class="input" data-dayname="${i}" value="${esc(d.name)}"></div>`).join('')}</div>
    <button class="btn primary block" id="st-save">Save settings</button>

    <h2>History & data</h2>
    <div class="card">
      <div class="btn-row">
        <button class="btn sm primary" data-action="open-import">Import ChatGPT export</button>
        <button class="btn sm" data-action="open-paste">Import notes / Markdown</button>
        <button class="btn sm" data-action="rebuild-plans">Rebuild all plans</button>
        <button class="btn sm" data-action="merge-ex">Merge exercise names</button>
      </div>
      <div class="btn-row mt">
        <button class="btn sm" data-action="export">Export backup</button>
        <label class="btn sm">Load backup / add sessions<input type="file" accept="application/json,.json" id="st-restore" hidden></label>
      </div>
      <div class="small muted mt">${doneSessions().length} sessions stored · ${persisted}</div>
    </div>
    <h2>Danger zone</h2>
    <div class="card"><button class="btn sm danger" data-action="wipe">Delete all data…</button></div>
    <div class="center tiny dim mt">Workout Coach v3.5</div>`;

  $('#st-save').onclick = async () => {
    s.apiKey = $('#st-key').value.trim();
    s.model = $('#st-model-custom').value.trim() || $('#st-model').value;
    s.goal = $('#st-goal').value.trim() || DEFAULT_SETTINGS.goal;
    s.rules = $('#st-rules').value.trim();
    s.coachStyle = $('#st-style').value.trim() || DEFAULT_SETTINGS.coachStyle;
    s.historyDepth = Math.max(2, Math.min(30, num($('#st-depth').value) || 8));
    s.bands = $('#st-bands').value.trim() || DEFAULT_SETTINGS.bands;
    document.querySelectorAll('[data-dayname]').forEach(inp => { state.days[+inp.dataset.dayname].name = inp.value.trim() || state.days[+inp.dataset.dayname].name; });
    document.querySelectorAll('[data-daycolor]').forEach(inp => { state.days[+inp.dataset.daycolor].color = inp.value; });
    await save.settings(); await save.days(); toast('Settings saved'); render(); runPending();
  };
  $('#st-restore').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = '';
    let data;
    try { data = JSON.parse(await readFileText(f)); if (!data || !Array.isArray(data.sessions)) throw new Error('Not a Workout Coach backup'); }
    catch (err) { return toast('Restore failed: ' + err.message, 4000); }
    const ids = new Set(state.sessions.map(x => x.id));
    const fresh = data.sessions.filter(x => !ids.has(x.id));
    modal(`<h3>Load backup file</h3>
      <p class="muted">The file has <b>${data.sessions.length}</b> session${data.sessions.length === 1 ? '' : 's'}, <b>${fresh.length}</b> ${fresh.length === 1 ? 'is' : 'are'} new to the app.</p>
      <button class="btn primary block mb" id="rs-add" ${fresh.length ? '' : 'disabled'}>Add ${fresh.length} new sessions</button>
      <div class="small muted mb">Keeps everything you have and adds only the new sessions. Plans and settings stay as they are.</div>
      <button class="btn danger block mb" id="rs-replace">Replace all data</button>
      <div class="small muted mb">Deletes the sessions, plans and reports in the app and loads the file instead. Your API key is kept.</div>
      <button class="btn ghost block" data-close>Cancel</button>`,
    (m, close) => {
      m.querySelector('#rs-add').onclick = async () => {
        const known = new Set(state.days.map(d => d.id));
        for (const d of data.days || []) if (!known.has(d.id)) state.days.push(d);
        state.sessions.push(...fresh); sortSessions(); await db.putSessions(fresh); await save.days();
        close(); toast(`${fresh.length} sessions added`); render();
      };
      m.querySelector('#rs-replace').onclick = async () => {
        close();
        if (!(await confirmDialog('Replace all data?', `This deletes the ${doneSessions().length} sessions in the app and loads ${data.sessions.length} from the file. Export a backup first if you are unsure.`, 'Replace data', true))) return;
        const key = state.settings.apiKey;
        state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), apiKey: key };
        state.days = data.days || state.days; state.plans = data.plans || {}; state.reports = data.reports || [];
        await db.clearSessions(); await db.putSessions(data.sessions); state.sessions = data.sessions; sortSessions();
        await save.settings(); await save.days(); await save.plans(); await save.reports();
        toast('Backup restored'); location.reload();
      };
    });
  };
}

function exportBackup() {
  const data = { app: 'workout-coach', version: 1, exportedAt: new Date().toISOString(), settings: { ...state.settings, apiKey: '' }, days: state.days, plans: state.plans, reports: state.reports, sessions: state.sessions };
  download(`${yymmdd()}_workout-coach-backup.json`, JSON.stringify(data, null, 1));
}

async function rebuildPlans() {
  if (!doneSessions().length) return toast('No history yet');
  if (!hasKey()) {
    modal(`<div class="row between"><h3>Rebuild all plans</h3><button class="icon-btn" data-close>✕</button></div>
      <div class="small muted mb">The coach builds your next session for every split day from your latest history.</div>${manualSteps('rbm', 'history')}`,
    (m, close) => wireManual(m, 'rbm', () => rebuildAllPrompt(), async text => {
      const plans = parseRebuild(text);
      for (const [dayId, plan] of Object.entries(plans)) { const old = state.plans[dayId]; state.plans[dayId] = { ...plan, prev: old ? { ...old, prev: undefined } : null }; }
      await save.plans(); close(); render(); toast(`${Object.keys(plans).length} plans updated — undo per day on the Coach tab`, 4000);
    }));
    return;
  }
  if (!(await confirmDialog('Rebuild all plans?', 'The coach builds a fresh next-session plan for each split day from your latest history. You can undo per day on the Coach tab.', 'Rebuild'))) return;
  const close = modal(`<h3>Rebuilding plans</h3><div id="rb-log" class="small muted"></div>`);
  const log = document.getElementById('rb-log');
  for (const d of planDays()) {
    if (!sessionsForDay(d.id).length) { log.innerHTML += `<div>${esc(d.name)}: no history, skipped</div>`; continue; }
    log.innerHTML += `<div id="rb-${d.id}"><span class="spinner"></span> ${esc(d.name)}…</div>`;
    try {
      const { plan } = await adjustPlan(d.id, 'Build the next session for this day from my most recent sessions and the coach notes. Keep my current exercise selection and order unless there is a clear reason to change it.');
      const old = state.plans[d.id];
      state.plans[d.id] = { ...plan, prev: old ? { ...old, prev: undefined } : null };
      await save.plans();
      document.getElementById('rb-' + d.id).textContent = `✓ ${d.name}`;
    } catch (err) { document.getElementById('rb-' + d.id).textContent = `✕ ${d.name}: ${err.message}`; }
  }
  log.innerHTML += '<button class="btn primary block mt" data-close-rb>Done</button>';
  log.querySelector('[data-close-rb]').onclick = () => { close(); render(); };
}

function mergeDialog() {
  const names = allExerciseNames().filter(x => x.count > 0);
  const opts = names.map(n => `<option value="${esc(n.name)}">${esc(n.name)} (${n.count})</option>`).join('');
  modal(`<h3>Merge exercise names</h3><div class="small muted mb">Use this when the same exercise was logged under different names, so charts and the coach treat it as one.</div>
    <label class="field"><span>Rename every</span><select class="input" id="mg-from">${opts}</select></label>
    <label class="field"><span>into</span><input class="input" id="mg-to" list="mg-list"><datalist id="mg-list">${names.map(n => `<option value="${esc(n.name)}">`).join('')}</datalist></label>
    <div class="btn-row"><button class="btn grow" data-close>Cancel</button><button class="btn primary grow" id="mg-ok">Merge</button></div>`,
  (m, close) => {
    m.querySelector('#mg-ok').onclick = async () => {
      const from = m.querySelector('#mg-from').value, to = m.querySelector('#mg-to').value.trim();
      if (!to || normName(from) === normName(to)) return;
      close();
      if (!(await confirmDialog('Merge names?', `Every "${from}" becomes "${to}" in all sessions and plans.`, 'Merge'))) return;
      const { n, touched } = mergeExercise(from, to);
      await db.putSessions(touched); await save.plans();
      toast(`${n} entries renamed`); render();
    };
  });
}

// ---------------------------------------------------------------- IMPORT
function importDialog() {
  if (!hasKey()) return toast('Importing raw logs needs an API key. Without one, restore a prepared backup file instead (Settings → Restore backup).', 6000);
  modal(`<div class="row between"><h3>Import ChatGPT export</h3><button class="icon-btn" data-close>✕</button></div>
    <div id="im-body">
      <ol class="small muted" style="padding-left:18px">
        <li>In ChatGPT: Settings → Data controls → Export data. You get an email with a .zip.</li>
        <li>Unzip it (on iPhone: tap the zip in Files).</li>
        <li>Pick <b>conversations.json</b> below (select all conversations*.json files if there are several).</li>
      </ol>
      <label class="btn primary block mt">Choose conversations.json<input type="file" id="im-file" accept="application/json,.json" multiple hidden></label>
      <div class="tiny dim mt">The file is read on this device. Only the workout logs you select are sent to Claude to be structured.</div>
    </div>`,
  (m, close) => {
    m.querySelector('#im-file').onchange = async e => {
      const body = m.querySelector('#im-body');
      body.innerHTML = '<div class="row"><span class="spinner"></span> Reading export…</div>';
      try {
        const jsons = [];
        for (const f of e.target.files) jsons.push(JSON.parse(await readFileText(f)));
        const convs = parseExport(jsons);
        if (!convs.length) { body.innerHTML = '<p class="muted">No workout logs found in this file.</p>'; return; }
        const pre = c => c.entries.length >= Math.max(3, convs[0].entries.length * 0.1);
        body.innerHTML = `<p class="small muted">Conversations that contain workout logs. Your long-running project chat should be at the top.</p>
          ${convs.slice(0, 30).map((c, i) => `<label class="list-check"><input type="checkbox" data-ci="${i}" ${pre(c) ? 'checked' : ''}><div class="grow"><b>${esc(c.title)}</b><div class="small muted">${c.entries.length} workout logs · ${c.entries[0].ts} → ${c.entries[c.entries.length - 1].ts}</div></div></label>`).join('')}
          <div class="small muted mt">Already-imported logs are skipped, so you can re-run this later with a newer export.</div>
          <button class="btn primary block mt" id="im-go">Import selected</button>`;
        m.querySelector('#im-go').onclick = () => {
          const picked = [...m.querySelectorAll('[data-ci]:checked')].map(x => convs[+x.dataset.ci]);
          const entries = picked.flatMap(c => c.entries).sort((a, b) => a.tsMs - b.tsMs);
          if (!entries.length) return;
          runImportUI(body, entries, close);
        };
      } catch (err) { body.innerHTML = `<p class="muted">Could not read the file: ${esc(err.message)}</p>`; }
    };
  });
}

function pasteDialog() {
  if (!hasKey()) return toast('Importing raw notes needs an API key. Without one, restore a prepared backup file instead (Settings → Restore backup).', 6000);
  modal(`<div class="row between"><h3>Import notes</h3><button class="icon-btn" data-close>✕</button></div>
    <div id="im-body">
      <div class="small muted mb">Choose a Markdown/text file, or paste Apple Notes or chat logs. Each workout should start with a line containing its date (e.g. "Apr 3", "## 16 August 2026", "2026-08-16").</div>
      <label class="btn block mb">Choose .md or .txt file<input type="file" id="pt-file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden></label>
      <textarea class="input" id="pt-text" style="min-height:200px;font-size:13.5px" placeholder="…or paste here"></textarea>
      <div class="small mt" id="pt-count"></div>
      <label class="field mt"><span>Year, when a date line doesn't say</span><input class="input" id="pt-year" inputmode="numeric" value="${new Date().getFullYear()}"></label>
      <button class="btn primary block" id="pt-go">Import</button>
    </div>`,
  (m, close) => {
    const year = () => num(m.querySelector('#pt-year').value) || new Date().getFullYear();
    const count = () => {
      const t = m.querySelector('#pt-text').value;
      const n = t.trim() ? splitPasted(t, year()).length : 0;
      m.querySelector('#pt-count').innerHTML = t.trim() ? (n ? `<span class="pill good">${n} workouts found</span>` : '<span class="pill warn">No workouts recognised</span>') : '';
    };
    m.querySelector('#pt-text').addEventListener('input', count);
    m.querySelector('#pt-year').addEventListener('input', count);
    m.querySelector('#pt-file').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      m.querySelector('#pt-text').value = await readFileText(f); count();
    };
    m.querySelector('#pt-go').onclick = () => {
      const entries = splitPasted(m.querySelector('#pt-text').value, year());
      if (!entries.length) return toast('No workout logs recognised');
      runImportUI(m.querySelector('#im-body'), entries, close);
    };
  });
}

async function runImportUI(body, entries, close) {
  let stop = false;
  body.innerHTML = `<div class="progressbar"><div id="im-bar"></div></div><div class="small muted mt" id="im-msg">Starting…</div><button class="btn block mt" id="im-stop">Stop</button>`;
  body.querySelector('#im-stop').onclick = () => { stop = true; body.querySelector('#im-stop').textContent = 'Stopping after this batch…'; };
  try {
    const res = await runImport(entries, {
      shouldStop: () => stop,
      onProgress: p => {
        const bar = body.querySelector('#im-bar'); if (bar) bar.style.width = (p.total ? (p.done / p.total) * 100 : 100) + '%';
        const msg = body.querySelector('#im-msg'); if (msg) msg.textContent = p.message;
      },
    });
    body.innerHTML = `<p><b>${res.created} sessions imported</b>${res.batches < res.total ? ` (stopped after ${res.batches} of ${res.total} batches; run the import again to continue)` : ''}.</p>
      <p class="small muted">Next: let the coach build fresh plans for all three days from your latest sessions, and check Settings → Merge exercise names if an exercise shows up under two names.</p>
      <div class="btn-row"><button class="btn grow" id="im-done">Close</button><button class="btn primary grow" id="im-rebuild">Rebuild plans</button></div>`;
    body.querySelector('#im-done').onclick = () => { close(); render(); };
    body.querySelector('#im-rebuild').onclick = () => { close(); render(); rebuildPlans(); };
  } catch (err) {
    body.innerHTML += `<p class="small muted mt">Import paused because of an error. Imported batches are saved; run the import again to continue where it stopped.</p><button class="btn block" id="im-done2">Close</button>`;
    body.querySelector('#im-done2').onclick = () => { close(); render(); };
  }
}

// ---------------------------------------------------------------- events
document.getElementById('tabbar').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
$('#btn-settings').onclick = () => go('settings');

view.addEventListener('input', e => { if (draftSession() && ui.tab === 'train' && !ui.detail) loggerInput(e); });
view.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.f === 'pain' && draftSession() && !ui.detail) loggerInput(e); });

view.addEventListener('click', async e => {
  const t = e.target.closest('[data-action],[data-start],[data-open],[data-go],[data-plan],[data-change-plan],[data-undo-plan],[data-hist],[data-pmode],[data-report]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.start) return startSession(ds.start);
  if (ds.open) { ui.detail = ds.open; render(); window.scrollTo(0, 0); return; }
  if (ds.go) return go(ds.go);
  if (ds.plan) return showPlan(ds.plan);
  if (ds.changePlan) return changePlanDialog(ds.changePlan);
  if (ds.undoPlan) {
    const p = state.plans[ds.undoPlan];
    if (p && p.prev && await confirmDialog('Undo last plan change?', 'The previous plan for this day is restored.', 'Undo')) { state.plans[ds.undoPlan] = p.prev; await save.plans(); render(); }
    return;
  }
  if (ds.hist) { ui.histFilter = ds.hist; return render(); }
  if (ds.pmode) { ui.progressMode = ds.pmode; return render(); }
  if (ds.report) return openReport(ds.report);
  const a = ds.action;
  if (['check', 'toggle-wu', 'band-pick', 'add-set', 'del-set', 'ex-menu', 'add-ex', 'discard', 'finish'].includes(a)) return loggerAction(a, t);
  switch (a) {
    case 'back': ui.detail = null; render(); return;
    case 'keep-review': { const s = state.sessions.find(x => x.id === ds.id); if (s && s.analysis && s.analysis.prev) { s.analysis = s.analysis.prev; await save.session(s); render(); } return; }
    case 'reanalyse': {
      const s = state.sessions.find(x => x.id === ds.id); if (!s) return;
      if (!hasKey()) { s.analysis = { status: 'manual', prev: s.analysis && s.analysis.status === 'done' ? s.analysis : null }; await save.session(s); render(); setTimeout(() => document.getElementById('mr-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); return; }
      if (s.analysis && s.analysis.status === 'done' && !(await confirmDialog('Re-run the review?', 'The current review is replaced. If this is your latest session for the day, the next plan is regenerated too (undo is available on the Coach tab).', 'Re-run'))) return;
      s.analysis = { status: 'pending' }; await save.session(s);
      return analyse(s);
    }
    case 'edit-session': {
      const s = state.sessions.find(x => x.id === ds.id);
      if (draftSession()) return toast('Finish or discard the workout in progress first');
      s.status = 'draft'; for (const ex of s.exercises) for (const x of ex.sets) { x.done = true; }
      await save.session(s); ui.detail = null; ui.tab = 'train'; render(); return;
    }
    case 'delete-session': {
      if (!(await confirmDialog('Delete this session?', 'It is removed from your history permanently.', 'Delete', true))) return;
      state.sessions = state.sessions.filter(x => x.id !== ds.id); await db.deleteSession(ds.id); ui.detail = null; render(); return;
    }
    case 'open-import': return importDialog();
    case 'open-paste': return pasteDialog();
    case 'rebuild-plans': return rebuildPlans();
    case 'merge-ex': return mergeDialog();
    case 'export': return exportBackup();
    case 'wipe': {
      if (!(await confirmDialog('Delete ALL data?', 'All sessions, plans, reports and settings on this device are deleted. Export a backup first if you might need it.', 'Delete everything', true))) return;
      await db.clearSessions(); for (const k of ['settings', 'days', 'plans', 'reports', 'usage', 'importDone', 'seeded']) await db.del(k);
      location.reload(); return;
    }
  }
});

function updateNet() { $('#net-status').hidden = navigator.onLine; }
window.addEventListener('online', () => { updateNet(); runPending(); if (ui.tab === 'train' || ui.detail) render(); });
window.addEventListener('offline', () => { updateNet(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runPending(); });

// ---------------------------------------------------------------- boot
(async function boot() {
  await loadAll();
  state._persisted = await requestPersistence();
  updateNet();
  // Sessions stuck in "running" from a closed app go back to the queue.
  render();
  runPending();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// test hook
window.__wc = { state, render, ui, runPending };
