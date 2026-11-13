// Free "copy & paste" coach mode: the app writes the prompt, the user runs it in the Claude app
// (covered by a Claude subscription) and pastes the reply back. No API key needed.
import { state, planDays, dayById, doneSessions, sessionToText, planToText, exerciseBestsText } from './store.js';
import { coachSystem, historyContext, planFromTool } from './ai.js';

const PLAN_SHAPE = `{"general_note": "one or two sentences of focus", "exercises": [{"name": "Exercise name", "note": "short cue or target, or empty", "sets": [{"weight": 80, "band": null, "reps": "8-10", "warmup": false}]}]}
For TRX & Bands sessions use "band" (e.g. "2 green / 1 blue") with "weight": null; for bodyweight sets both are null.`;

const intro = () => `${coachSystem()}\n\n(I'm pasting this from my training app. Please answer in the exact reply format at the end so the app can read it.)`;

export function reviewPrompt(session) {
  const day = dayById(session.dayId);
  return [
    intro(),
    historyContext(session.dayId, session.id),
    `## Plan that was prescribed for today\n${planToText(state.plans[session.dayId])}`,
    `## TODAY'S SESSION (review this one)\n${sessionToText(session)}`,
    `Review today's session, rate it, and prescribe my next ${day.name} session. Keep exercise names stable; only change exercises or order with a reason.${['travel', 'free'].includes(day.kind) ? ' This is a flexible session: rate only what I actually did; skipped exercises were a time decision and must not lower the rating.' : ''}`,
    `## Reply format (important)
RATING: <number>/10
HEADLINE: <one sentence verdict>

<the full review in Markdown: per exercise vs. target and vs. last time, what went well, what didn't, pain trends, a short comparison table, the key takeaway>

LOG SUMMARY: <two or three compact lines for my long-term log>

Finish with the next ${day.name} session as one JSON code block (\`\`\`json … \`\`\`) in exactly this shape (weight in kg, null if unknown; reps as text). Write your whole answer, including the JSON, directly in the chat message. Do not create a file, artifact or document.
${PLAN_SHAPE}`,
  ].join('\n\n');
}

export function planChangePrompt(dayId, request) {
  const day = dayById(dayId);
  return [
    intro(),
    historyContext(dayId),
    `## Current plan for my next ${day.name} session\n${planToText(state.plans[dayId])}`,
    `## My request\n${request}`,
    `## Reply format (important)
First a short Markdown explanation of what you changed and why.
Then the complete updated next ${day.name} session as one JSON code block (\`\`\`json … \`\`\`) in exactly this shape. Write your whole answer, including the JSON, directly in the chat message. Do not create a file, artifact or document.
${PLAN_SHAPE}`,
  ].join('\n\n');
}

export function rebuildAllPrompt() {
  const days = planDays().filter(d => doneSessions().some(s => s.dayId === d.id));
  const blocks = days.map(d => historyContext(d.id).split('\n\n## Most recent other sessions')[0]);
  return [
    intro(),
    blocks.join('\n\n'),
    `## Long-term top sets per exercise\n${exerciseBestsText()}`,
    `Build my next session for each split day from my most recent sessions. Keep my exercise selection and order unless there is a clear reason to change it, and keep exercise names exactly as logged.`,
    `## Reply format (important)
A few lines of Markdown on the main priorities, then ONE JSON code block (\`\`\`json … \`\`\`) with all plans, keyed by day id. Write your whole answer, including the JSON, directly in the chat message. Do not create a file, artifact or document.
{"plans": {${days.map(d => `"${d.id}": <plan for ${d.name}>`).join(', ')}}}
where each plan has exactly this shape:
${PLAN_SHAPE}`,
  ].join('\n\n');
}

export function reportPrompt(from, to, focus) {
  const sess = doneSessions().filter(s => s.date >= from && s.date <= to).reverse();
  return { count: sess.length, text: [
    intro(),
    `## All sessions from ${from} to ${to} (oldest first, ${sess.length} sessions)`,
    sess.map(s => sessionToText(s)).join('\n\n'),
    `## Long-term top sets per exercise\n${exerciseBestsText(60)}`,
    `Write a progress report for this period in Markdown. Cover: consistency (sessions per week per split day), strength progression of the key lifts with start→end numbers, body weight trend if logged, pain/injury trends and how they were managed, what worked, what stalled, and 3–5 concrete priorities for the next months toward my goal. Use tables where helpful. Write it directly in the chat message, not as a file, artifact or document.${focus ? `\nI especially want to know: ${focus}` : ''}`,
  ].join('\n\n') };
}

// ---------- parsing replies ----------
function jsonBlocks(text) {
  const out = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi; let m;
  while ((m = re.exec(text))) out.push({ raw: m[0], body: m[1] });
  if (!out.length) { // no fences: take the last balanced {...}
    const end = text.lastIndexOf('}');
    for (let i = text.indexOf('{'); i >= 0 && i < end; i = text.indexOf('{', i + 1)) {
      try { JSON.parse(text.slice(i, end + 1)); out.push({ raw: text.slice(i, end + 1), body: text.slice(i, end + 1) }); break; } catch (e) {}
    }
  }
  return out;
}

function parseJson(body) {
  try { return JSON.parse(body); } catch (e) {}
  try { return JSON.parse(body.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
}

function findPlanJson(text) {
  const blocks = jsonBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const j = parseJson(blocks[i].body);
    if (j && (Array.isArray(j.exercises) || (j.next_session && Array.isArray(j.next_session.exercises)) || (j.plan && Array.isArray(j.plan.exercises)) || j.plans)) return { json: j, raw: blocks[i].raw };
  }
  return null;
}

const field = (text, name) => { const m = text.match(new RegExp(`^[*_#\\s]*${name}[*_\\s]*:[*_\\s]*(.+)$`, 'im')); return m ? m[1].replace(/[*_]+$/g, '').trim() : ''; };

export function parseReview(text, dayId, sessionId) {
  const t = String(text || '').trim();
  if (!t) throw new Error('The pasted reply is empty.');
  const found = findPlanJson(t);
  let rating = null;
  const rm = t.match(/rating[*_\s]*:?[*_\s]*(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*10/i) || t.match(/(\d{1,2}(?:[.,]\d)?)\s*\/\s*10/);
  if (rm) { const v = Number(rm[1].replace(',', '.')); if (v >= 0 && v <= 10) rating = v; }
  let headline = field(t, 'HEADLINE');
  let summary = field(t, 'LOG SUMMARY');
  const j = found ? found.json : {};
  if (rating == null && j.rating != null && !isNaN(parseFloat(j.rating))) rating = parseFloat(j.rating);
  if (!headline && typeof j.headline === 'string') headline = j.headline;
  if (!summary && typeof (j.log_summary || j.summary) === 'string') summary = j.log_summary || j.summary;
  let markdown = t;
  if (found) markdown = markdown.replace(found.raw, '');
  markdown = markdown.split('\n').filter(l => !/^[*_#\s]*(RATING|HEADLINE|LOG SUMMARY)[*_\s]*:/i.test(l)).join('\n')
    .replace(/\n*(here is|here's)?[^\n]*next[^\n]*session[^\n]*(as|in)[^\n]*json[^\n]*:?\s*$/i, '').trim();
  if (!markdown && typeof (j.review_markdown || j.review) === 'string') markdown = j.review_markdown || j.review;
  if (!found && rating == null && markdown.length < 40) throw new Error('This doesn\'t look like Claude\'s review. Copy its whole answer (copy icon under the answer) and paste it here.');
  let plan = null;
  if (found) {
    const ns = found.json.next_session || found.json.plan || (found.json.plans ? found.json.plans[dayId] : found.json);
    if (ns && Array.isArray(ns.exercises)) plan = planFromTool(dayId, ns, sessionId, 'claude-app');
  }
  return { rating, headline, summary, markdown, plan };
}

export function parsePlanReply(text, dayId) {
  const t = String(text || '').trim();
  const found = findPlanJson(t);
  if (!found) throw new Error('No plan found in the reply. Make sure you pasted Claude\'s whole answer, including the JSON block at the end.');
  const ns = found.json.next_session || found.json.plan || (found.json.plans ? found.json.plans[dayId] : found.json);
  if (!ns || !Array.isArray(ns.exercises) || !ns.exercises.length) throw new Error('The plan in the reply has no exercises.');
  return { explanation: t.replace(found.raw, '').trim() || 'Updated plan.', plan: planFromTool(dayId, ns, null, 'claude-app') };
}

export function parseRebuild(text) {
  const found = findPlanJson(String(text || ''));
  if (!found || !found.json.plans) throw new Error('No plans found in the reply. Paste Claude\'s whole answer, including the JSON block.');
  const plans = {};
  for (const d of planDays()) {
    const ns = found.json.plans[d.id];
    if (ns && Array.isArray(ns.exercises) && ns.exercises.length) plans[d.id] = planFromTool(d.id, ns, null, 'claude-app');
  }
  if (!Object.keys(plans).length) throw new Error('The reply contained no usable plans.');
  return plans;
}
