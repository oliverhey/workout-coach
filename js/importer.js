// ChatGPT data-export importer (conversations.json) + paste importer.
import { state, save, uid, normName, sortSessions, allExerciseNames } from './store.js';
import { db } from './db.js';
import { structureLogs } from './ai.js';

const SET_RE = /\b\d+(?:[.,]\d+)?\s*[x×]\s*\d+/gi;
export const looksLikeWorkout = t => (String(t).match(SET_RE) || []).length >= 4;

function textOf(msg) {
  if (!msg || !msg.content) return '';
  const c = msg.content;
  if (Array.isArray(c.parts)) return c.parts.filter(p => typeof p === 'string').join('\n').trim();
  if (typeof c.text === 'string') return c.text.trim();
  return '';
}

function linearize(conv) {
  const mapping = conv.mapping || {};
  let nodeId = conv.current_node;
  if (!nodeId || !mapping[nodeId]) {
    // fall back to the latest leaf
    const leaves = Object.values(mapping).filter(n => !n.children || !n.children.length);
    leaves.sort((a, b) => ((b.message && b.message.create_time) || 0) - ((a.message && a.message.create_time) || 0));
    nodeId = leaves[0] && leaves[0].id;
  }
  const chain = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    const n = mapping[nodeId];
    if (n.message) chain.push(n.message);
    nodeId = n.parent;
  }
  return chain.reverse();
}

// Returns [{id, title, created, updated, entries:[{id, ts, text, reply}]}]
export function parseExport(jsonList) {
  const convs = [];
  for (const j of jsonList) {
    const arr = Array.isArray(j) ? j : (Array.isArray(j.conversations) ? j.conversations : [j]);
    for (const c of arr) if (c && c.mapping) convs.push(c);
  }
  return convs.map(c => {
    const msgs = linearize(c);
    const entries = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m.author || m.author.role !== 'user') continue;
      const text = textOf(m);
      if (!looksLikeWorkout(text)) continue;
      let reply = '';
      for (let k = i + 1; k < msgs.length; k++) {
        const n = msgs[k];
        if (n.author && n.author.role === 'user') break;
        if (n.author && n.author.role === 'assistant' && n.content && (n.content.content_type === 'text' || !n.content.content_type)) {
          const t = textOf(n); if (t) reply += (reply ? '\n\n' : '') + t;
        }
      }
      const ts = m.create_time ? new Date(m.create_time * 1000) : (c.create_time ? new Date(c.create_time * 1000) : new Date());
      entries.push({ id: m.id || uid(), ts: ts.toISOString().slice(0, 10), tsMs: ts.getTime(), text, reply });
    }
    return {
      id: c.conversation_id || c.id || uid(), title: c.title || '(untitled)',
      created: c.create_time ? new Date(c.create_time * 1000) : null,
      updated: c.update_time ? new Date(c.update_time * 1000) : null,
      entries,
    };
  }).filter(c => c.entries.length).sort((a, b) => b.entries.length - a.entries.length);
}

export function ratingFromReply(reply) {
  const m = String(reply || '').match(/(?:overall|rating|session rating|score|grade)[^0-9\n]{0,25}(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*10/i);
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  return v >= 0 && v <= 10 ? v : null;
}

// Split pasted text into entries at date-like header lines.
export function splitPasted(text, year) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const isHeader = l => /^\s*(#+\s*)?(📒\s*)?([A-Z][a-z]{2,8}\.?\s+\d{1,2}(,?\s*\d{4})?|\d{1,2}[./]\s?\d{1,2}[./]?\s?(\d{2,4})?|\d{4}-\d{2}-\d{2})\b/.test(l);
  const chunks = []; let cur = [];
  for (const l of lines) { if (isHeader(l) && cur.join('').trim()) { chunks.push(cur.join('\n')); cur = []; } cur.push(l); }
  if (cur.join('').trim()) chunks.push(cur.join('\n'));
  const ts = `${year}-12-31`;
  return chunks.filter(looksLikeWorkout).map(t => ({ id: uid(), ts, tsMs: Date.now(), text: t.trim(), reply: '' }));
}

function batches(entries, maxChars = 14000, maxN = 12) {
  const out = []; let cur = []; let n = 0;
  for (const e of entries) {
    const len = e.text.length;
    if (cur.length && (n + len > maxChars || cur.length >= maxN)) { out.push(cur); cur = []; n = 0; }
    cur.push(e); n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Runs the import. onProgress({done, total, sessions, message}). Resumable via kv "importDone".
export async function runImport(entries, { onProgress, shouldStop } = {}) {
  const doneIds = new Set((await db.get('importDone')) || []);
  const todo = entries.filter(e => !doneIds.has(e.id));
  const groups = batches(todo);
  let created = 0, done = 0;
  const total = groups.length;
  onProgress && onProgress({ done, total, sessions: created, message: total ? `Structuring ${todo.length} logs in ${total} batches…` : 'Nothing new to import.' });
  for (const g of groups) {
    if (shouldStop && shouldStop()) break;
    const known = allExerciseNames().slice(0, 150).map(x => x.name);
    let result;
    try {
      result = await structureLogs(g.map(e => ({ ts: e.ts, text: e.text })), known);
    } catch (err) {
      onProgress && onProgress({ done, total, sessions: created, message: 'Error: ' + err.message, error: true });
      throw err;
    }
    const firstForEntry = new Set();
    const toSave = [];
    for (const r of result) {
      const e = g[r.entry]; if (!e) continue;
      if (!r.exercises || !r.exercises.length) continue;
      const dayId = r.day === 'other' ? 'other' : r.day;
      const sess = {
        id: 'imp_' + e.id + '_' + toSave.length, date: r.date || e.ts, dayId, title: r.title || '', status: 'done',
        startedAt: e.tsMs, finishedAt: e.tsMs, bodyweight: r.bodyweight ?? null, notes: r.notes || '', source: 'import', importTs: e.tsMs,
        exercises: r.exercises.map(x => ({ id: uid(), name: x.name, note: '', userNote: x.note || '',
          sets: (x.sets || []).map(s => ({ w: s.w ?? null, r: s.r ?? null, pain: s.pain ?? null, wu: !!s.wu, done: true, tw: null, tr: null })) })),
        analysis: null,
      };
      if (!firstForEntry.has(r.entry) && e.reply) {
        firstForEntry.add(r.entry);
        sess.analysis = { status: 'done', source: 'chatgpt', rating: ratingFromReply(e.reply), headline: '', markdown: e.reply, summary: '', at: e.tsMs };
      }
      // De-duplicate on date + day: the later message wins; sessions logged in this app are never overwritten.
      const clash = state.sessions.find(s => s.date === sess.date && s.dayId === sess.dayId && s.status === 'done');
      if (clash) {
        if (clash.source !== 'import') continue;
        if ((clash.importTs || 0) > sess.importTs) continue;
        state.sessions = state.sessions.filter(s => s !== clash);
        await db.deleteSession(clash.id);
        if (!sess.analysis && clash.analysis) sess.analysis = clash.analysis;
      }
      state.sessions.push(sess); toSave.push(sess); created++;
    }
    await db.putSessions(toSave);
    g.forEach(e => doneIds.add(e.id));
    await db.set('importDone', [...doneIds]);
    sortSessions();
    done++;
    onProgress && onProgress({ done, total, sessions: created, message: `Batch ${done}/${total} done — ${created} sessions so far.` });
  }
  return { created, batches: done, total };
}

export async function resetImportProgress() { await db.del('importDone'); }

export function mergeExercise(fromName, toName) {
  const k = normName(fromName); let n = 0;
  const touched = [];
  for (const s of state.sessions) {
    let hit = false;
    for (const ex of s.exercises || []) if (normName(ex.name) === k) { ex.name = toName; hit = true; n++; }
    if (hit) touched.push(s);
  }
  for (const p of Object.values(state.plans)) for (const ex of p.exercises || []) if (normName(ex.name) === k) ex.name = toName;
  return { n, touched };
}

export { save };
