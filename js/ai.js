// Claude API integration. Calls go straight from the device to api.anthropic.com with the user's own key.
import { state, save, dayById, sessionsForDay, doneSessions, sessionToText, planToText, exerciseBestsText, todayISO } from './store.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (recommended)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most thorough)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
];

export class AIError extends Error {}

export function hasKey() { return !!(state.settings.apiKey || '').trim(); }

async function call({ system, messages, tool, maxTokens = 8000 }) {
  if (!hasKey()) throw new AIError('No Anthropic API key set. Add one in Settings.');
  if (!navigator.onLine) throw new AIError('You are offline. The request will run when you are back online.');
  const body = { model: state.settings.model || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages };
  if (tool) { body.tools = [tool]; body.tool_choice = { type: 'tool', name: tool.name }; }
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': state.settings.apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AIError('Network error while contacting Claude: ' + e.message);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText;
    throw new AIError(`Claude API error ${res.status}: ${msg}`);
  }
  if (data.usage) {
    state.usage.input += data.usage.input_tokens || 0;
    state.usage.output += data.usage.output_tokens || 0;
    save.usage();
  }
  if (tool) {
    const block = (data.content || []).find(b => b.type === 'tool_use');
    if (!block) throw new AIError('Claude did not return structured output. Try again.');
    if (data.stop_reason === 'max_tokens') throw new AIError('Claude ran out of output space. Try again or pick a smaller batch.');
    return block.input;
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

export function coachSystem() {
  const s = state.settings;
  return [
    'You are the personal strength & hypertrophy coach of one client. You keep a long-running training log for them and plan every session.',
    `Today is ${todayISO()}. Units are kg. Sets are written weight×reps, "wu" marks a warm-up set, "@n/10" is the client\'s pain score for that set.`,
    `Client goal: ${s.goal}`,
    `Standing rules you always respect:\n${s.rules}`,
    `Style: ${s.coachStyle}`,
    `The client trains these split days: ${state.days.map(d => d.name).join(' / ')}.`,
    'Never invent performance data. If something was not recorded, say so. Write in English. Use Markdown (short headings, bold, small tables) — this is read on a phone.',
  ].join('\n\n');
}

const PLAN_SCHEMA = {
  type: 'object',
  description: 'The prescribed next session for this split day, in the order to perform it.',
  properties: {
    general_note: { type: 'string', description: 'One or two sentences of focus for the next session.' },
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exercise name; keep the exact same name as in the log unless it is a new exercise.' },
          note: { type: 'string', description: 'Short cue or target for the client, e.g. "Goal 80×8 at ≤2/10 pain". Empty if nothing to say.' },
          sets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                weight: { type: ['number', 'null'], description: 'Target load in kg; null if unknown (e.g. new machine).' },
                reps: { type: 'string', description: 'Target reps, e.g. "10" or "8-10".' },
                warmup: { type: 'boolean' },
              },
              required: ['weight', 'reps', 'warmup'],
            },
          },
        },
        required: ['name', 'note', 'sets'],
      },
    },
  },
  required: ['general_note', 'exercises'],
};

export function planFromTool(dayId, ns, sourceSessionId, origin) {
  return {
    dayId, origin, createdAt: Date.now(), sourceSessionId: sourceSessionId || null,
    generalNote: ns.general_note || '',
    exercises: (ns.exercises || []).map(e => ({
      name: e.name, note: e.note || '',
      sets: (e.sets || []).map(s => ({ w: typeof s.weight === 'number' ? s.weight : null, r: String(s.reps ?? ''), wu: !!s.warmup })),
    })),
  };
}

export function historyContext(dayId, excludeId) {
  const depth = state.settings.historyDepth || 8;
  const same = sessionsForDay(dayId).filter(s => s.id !== excludeId).slice(0, depth);
  const others = state.days.filter(d => d.id !== dayId).map(d => sessionsForDay(d.id).filter(s => s.id !== excludeId)[0]).filter(Boolean);
  const recentAll = doneSessions().filter(s => s.id !== excludeId).slice(0, 6);
  return [
    `## Previous ${dayById(dayId).name} sessions (newest first)\n` + (same.length ? same.map(s => sessionToText(s, { withAnalysis: true })).join('\n\n') : '(none yet)'),
    `## Most recent other sessions (for recovery and scheduling context)\n` + (others.length ? others.map(s => sessionToText(s)).join('\n\n') : '(none)'),
    `## Training dates in the last weeks\n` + recentAll.map(s => `${s.date}: ${s.title || dayById(s.dayId).name}`).join('\n'),
    `## Long-term top sets per exercise\n` + (exerciseBestsText() || '(no history yet)'),
  ].join('\n\n');
}

// 1) Review a finished session and plan the next one.
export async function analyzeSession(session) {
  const plan = state.plans[session.dayId];
  const tool = {
    name: 'submit_review',
    description: 'Submit the session review and the plan for the next session of this split day.',
    input_schema: {
      type: 'object',
      properties: {
        rating: { type: 'number', description: 'Overall session rating out of 10, one decimal.' },
        headline: { type: 'string', description: 'One sentence verdict.' },
        review_markdown: { type: 'string', description: 'The full review in Markdown: per exercise what happened vs. target and vs. last time, what went well, what did not, pain trends, a comparison table vs. the previous session, and the key takeaway. Do not repeat the next-session plan as a full list here; mention only the important changes.' },
        log_summary: { type: 'string', description: 'Two or three compact lines for the long-term log: key top sets, new bests, pain, context.' },
        next_session: PLAN_SCHEMA,
      },
      required: ['rating', 'headline', 'review_markdown', 'log_summary', 'next_session'],
    },
  };
  const user = [
    historyContext(session.dayId, session.id),
    `## Plan that was prescribed for today\n${planToText(plan)}`,
    `## TODAY'S SESSION (review this one)\n${sessionToText(session)}`,
    'Review today\'s session, rate it, and prescribe the next ' + dayById(session.dayId).name + ' session. Keep exercise names stable. Only change exercises or order when there is a reason, and say why in the review.',
  ].join('\n\n');
  const out = await call({ system: coachSystem(), messages: [{ role: 'user', content: user }], tool, maxTokens: 10000 });
  return { review: out, plan: planFromTool(session.dayId, out.next_session, session.id, 'ai') };
}

// 2) Change the plan on request (substitute, reorder, freshen up, or rebuild from history).
export async function adjustPlan(dayId, request) {
  const tool = {
    name: 'submit_plan',
    description: 'Submit the updated next-session plan for this split day.',
    input_schema: {
      type: 'object',
      properties: {
        explanation_markdown: { type: 'string', description: 'Short Markdown explanation of what changed and why.' },
        next_session: PLAN_SCHEMA,
      },
      required: ['explanation_markdown', 'next_session'],
    },
  };
  const user = [
    historyContext(dayId),
    `## Current plan for the next ${dayById(dayId).name} session\n${planToText(state.plans[dayId])}`,
    `## Client request\n${request}`,
  ].join('\n\n');
  const out = await call({ system: coachSystem(), messages: [{ role: 'user', content: user }], tool, maxTokens: 6000 });
  return { explanation: out.explanation_markdown, plan: planFromTool(dayId, out.next_session, null, 'ai') };
}

// 3) Progress report over a period.
export async function progressReport(fromDate, toDate, focus) {
  const sess = doneSessions().filter(s => s.date >= fromDate && s.date <= toDate).reverse();
  if (!sess.length) throw new AIError('No sessions in that period.');
  const user = [
    `## All sessions from ${fromDate} to ${toDate} (oldest first, ${sess.length} sessions)`,
    sess.map(s => sessionToText(s)).join('\n\n'),
    `## Long-term top sets per exercise\n${exerciseBestsText(60)}`,
    `Write a progress report for this period. Cover: consistency (sessions per week per split day), strength progression of the key lifts with start→end numbers, body weight trend if logged, pain/injury trends and how they were managed, what worked, what stalled, and 3–5 concrete priorities for the next months toward the goal. Use tables where helpful.${focus ? `\nThe client especially wants to know: ${focus}` : ''}`,
  ].join('\n\n');
  return call({ system: coachSystem(), messages: [{ role: 'user', content: user }], maxTokens: 8000 });
}

// 4) Turn raw historical logs (ChatGPT messages / notes) into structured sessions.
export async function structureLogs(entries, knownNames) {
  const tool = {
    name: 'submit_sessions',
    description: 'Submit the structured workout sessions found in the raw logs.',
    input_schema: {
      type: 'object',
      properties: {
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entry: { type: 'integer', description: 'Index of the raw entry this session came from.' },
              date: { type: 'string', description: 'YYYY-MM-DD. Use the date written in the log; resolve the year from the message timestamp. If no date is written, use the timestamp date.' },
              day: { type: 'string', enum: [...state.days.map(d => d.id), 'other'], description: 'Best matching split day.' },
              title: { type: 'string', description: 'Short label of the muscle groups trained, e.g. "Back / Biceps / Legs".' },
              bodyweight: { type: ['number', 'null'] },
              notes: { type: 'string', description: 'Context the client wrote (soreness, pain remarks, partner workout, machine changes). Empty if none.' },
              exercises: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Canonical exercise name in Title Case. Reuse a name from the known list when it is the same exercise.' },
                    note: { type: 'string' },
                    sets: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          w: { type: ['number', 'null'] }, r: { type: ['integer', 'null'] },
                          pain: { type: ['number', 'null'] }, wu: { type: 'boolean' },
                        },
                        required: ['w', 'r', 'pain', 'wu'],
                      },
                    },
                  },
                  required: ['name', 'note', 'sets'],
                },
              },
            },
            required: ['entry', 'date', 'day', 'title', 'bodyweight', 'notes', 'exercises'],
          },
        },
      },
      required: ['sessions'],
    },
  };
  const system = [
    'You convert a lifter\'s raw workout notes into structured data. Be exact: copy every set as written; do not invent, round or fill in missing numbers (use null).',
    'Sets are written like "70x12", "80x 10 pain 3/10", "20x15" etc. A per-set "pain n/10" goes into that set\'s pain. An "overall pain" line goes into the exercise note. A set explicitly called "warm up" is wu=true.',
    'Some entries are coach reviews or logs that mix performed sets with targets ("next time 92.5×8–10"), plans for the next session and comparisons with earlier dates ("Aug 2: 85×8"). Extract only the sets actually performed in that entry\'s own session: never targets, plans or numbers quoted from other dates. If the performed sets for an exercise are not recorded, return the exercise with an empty sets list and say so in its note.',
    'If an entry is not a workout log (a question, a plan request, chat, a pure comparison table), return nothing for it. If one entry contains two different dated workouts, return two sessions. If the same workout appears in several entries (re-sent or corrected), return it each time; duplicates are handled later.',
    `Split days: ${state.days.map(d => `${d.id} = ${d.name}`).join('; ')}. Pick the closest; use "other" only for sessions that match none (e.g. a pure cardio day).`,
  ].join('\n');
  const user = [
    knownNames.length ? `Known canonical exercise names (reuse these):\n${knownNames.join('; ')}` : 'No known exercise names yet.',
    entries.map((e, i) => `=== ENTRY ${i} (message timestamp ${e.ts}) ===\n${e.text}`).join('\n\n'),
  ].join('\n\n');
  const out = await call({ system, messages: [{ role: 'user', content: user }], tool, maxTokens: 16000 });
  return out.sessions || [];
}
