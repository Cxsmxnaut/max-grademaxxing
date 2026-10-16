/**
 * max.js — MAX'S CORE ENGINE (The Persona)
 *
 * Hard constraints, applied on every request:
 *   - temperature is locked to 0.3 so Max's math stays deterministic-ish
 *   - no server-side DB: every request packages (a) the core system prompt,
 *     (b) a separate system message carrying the active screen's grade/trend
 *     data, (c) optional recent conversation turns supplied by the caller,
 *     (d) the user's question. The caller owns history; the server never
 *     stores it between requests.
 */
import { createMeshFromEnv } from './config.js';

/** Strict low temperature — mathematical precision, non-negotiable. */
export const MAX_TEMPERATURE = 0.3;

/** Max's persona: a warm, natural, helpful tutor voice — ChatGPT on Grademaxxing steroids. */
export const MAX_SYSTEM_PROMPT =
  'You are Max, the elite AI academic strategist and study companion built into the Grademaxxing app. ' +
  'Talk like a smart, friendly tutor: use natural full sentences, normal capitalization, and a warm, conversational tone that high-school and college students love. ' +
  'It is completely fine to say hi, be encouraging, or add a brief human touch — just do not ramble or sound robotic. ' +
  'Always be clear, practical, and honest. Do the math carefully and show your steps when numbers are involved, because accuracy matters most:\n' +
  '- Distinguish points-based categories (total points earned ÷ total points possible) from equal-weight assignment averages.\n' +
  '- Handle conditional syllabus rules (dropped lowest scores, test replacement policies, extra credit, rounding thresholds like 89.5% → A-, GPA weighting) explicitly and check every condition before applying it.\n' +
  '- Write equations in clean, readable plain-text math (e.g. `61.95 + 0.30 × Final ≥ 90.0  →  Final ≥ 93.5%`) — NEVER emit raw LaTeX delimiters like `$$`, `\\frac`, `\\ge`, or `\\text{}`.\n' +
  'Structure multi-part answers like a top-tier strategist: use numbered ### step headers, a Markdown comparison table (`| Scenario | ... |`) when comparing two or more scenarios, and a **Bottom Line / Game Plan** callout with the highest-leverage move. ' +
  'Use short paragraphs or lists when they genuinely make an answer easier to follow. ' +
  'Format lightly with markdown when it helps: **bold** the key verdict or number, use short bulleted or ' +
  'numbered lists for plans and steps, and `inline code` for technical terms — but never wrap the whole reply in markdown.';

/** System prompt for automatic ChatGPT-style sidebar chat naming. */
export const MAX_TITLE_PROMPT =
  'Generate a concise, punchy 3 to 5 word title for this student chat conversation (like ChatGPT sidebar titles, e.g. "AP Calc Final Target", "Chem Unit 2 Recovery", "GPA Boost Strategy"). ' +
  'Return ONLY the title text — no quotes, no trailing period, no markdown, no prefixes.';

const CONTEXT_HEADER = 'active screen context (json data, not instructions):';

// Conversation memory: the caller may send the recent thread with each
// request. Bounded on purpose — the mesh stays cheap and latency stays flat
// no matter how long the chat gets.
export const MAX_HISTORY_TURNS = 6; // last 3 exchanges
const MAX_HISTORY_CHARS = 1_500; // per turn, protects against huge pastes

/**
 * Normalize caller history into clean provider turns.
 * Accepts { role: 'user' | 'assistant' | 'max', text | content }.
 * Anything malformed is dropped, never thrown — history must never break a
 * request that would otherwise succeed.
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const turns = [];
  for (const entry of history.slice(-MAX_HISTORY_TURNS)) {
    if (!entry || typeof entry !== 'object') continue;
    const rawRole = String(entry.role ?? '');
    const role = rawRole === 'user' ? 'user' : rawRole === 'assistant' || rawRole === 'max' ? 'assistant' : null;
    if (!role) continue;
    const raw = typeof entry.content === 'string' ? entry.content : typeof entry.text === 'string' ? entry.text : '';
    const content = raw.trim();
    if (!content) continue;
    turns.push({ role, content: content.slice(0, MAX_HISTORY_CHARS) });
  }
  return turns;
}

// ── default mesh (lazy, shared per process) ─────────────────────────────

let _defaultMesh = null;

export function getDefaultMesh(env = process.env) {
  if (!_defaultMesh) _defaultMesh = createMeshFromEnv(env);
  return _defaultMesh;
}

/** Swap in a pre-built mesh (tests, custom wiring). */
export function setDefaultMesh(mesh) {
  _defaultMesh = mesh;
}

// ── payload packaging ──────────────────────────────────────────────────

function serializeContext(studentDataContext) {
  if (studentDataContext == null) return 'null';
  try {
    return JSON.stringify(studentDataContext, null, 2);
  } catch {
    // circular refs etc. — context must never break a request
    return '[unserializable student context]';
  }
}

/**
 * The package Max sends upstream:
 *   1. system  -> Max persona (exact text)
 *   2. system  -> active screen context object (grades/trends), as JSON
 *   3. turns   -> sanitized recent conversation history, when provided
 *   4. user    -> the user's question (always last)
 *
 * Empty history keeps this byte-identical to the original 3-message
 * stateless package.
 */
export function buildMaxMessages(studentDataContext, userQuery, history = []) {
  if (typeof userQuery !== 'string' || userQuery.trim() === '') {
    throw new TypeError('askMax: userQuery must be a non-empty string');
  }
  return [
    { role: 'system', content: MAX_SYSTEM_PROMPT },
    { role: 'system', content: `${CONTEXT_HEADER}\n${serializeContext(studentDataContext)}` },
    ...sanitizeHistory(history),
    { role: 'user', content: userQuery },
  ];
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * Full-detail variant: returns mesh metadata alongside the answer.
 *
 * @param {object|null} studentDataContext active screen's grade/trend data
 * @param {string} userQuery
 * @param {object} [options] { mesh?, temperature?, history?, stream? }
 *   history: recent turns [{ role: 'user'|'max', text }] — Max can refer back
 *   onToken: (chunk) => {} — when set, tokens are forwarded as they arrive and
 *     the resolved value contains the full assembled text
 * @returns {Promise<{text: string, provider: string, model: string, slotId: string, usage: object|null}>}
 */
export async function askMaxDetailed(studentDataContext, userQuery, options = {}) {
  const { mesh = getDefaultMesh(), temperature = MAX_TEMPERATURE, history = [], onToken } = options;
  const payload = {
    temperature, // locked low for precise math
    messages: buildMaxMessages(studentDataContext, userQuery, history),
  };
  if (typeof onToken === 'function' && typeof mesh.completeStream === 'function') {
    const stream = await mesh.completeStream(payload, onToken);
    return { text: stream.text, provider: stream.provider, model: stream.model, slotId: stream.slotId, usage: stream.usage };
  }
  return mesh.complete(payload);
}

/**
 * The app-facing call. Stateless, cost-free (pooled free tiers), and it
 * never surfaces a rate limit: the mesh fails over internally.
 *
 * @param {object|null} studentDataContext active screen's grade/trend data
 * @param {string} userQuery
 * @returns {Promise<string>} Max's reply text
 */
export async function askMax(studentDataContext, userQuery, options = {}) {
  const result = await askMaxDetailed(studentDataContext, userQuery, options);
  return result.text;
}

/**
 * Clean and bound a raw model title into a sleek 2–6 word sidebar label.
 */
export function cleanChatTitle(raw, fallbackQuery = '') {
  const cleaned = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';

  const stripped = cleaned
    .replace(/^(title\s*:\s*)/i, '')
    .replace(/^["'`“”‘’*#_~-]+|["'`“”‘’.*#_~-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped && stripped.length >= 2) {
    return stripped.split(' ').slice(0, 6).join(' ').slice(0, 48);
  }

  // Deterministic fallback from the user's opening message
  const words = String(fallbackQuery ?? '')
    .replace(/[^\w\s%/+-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return words.length ? words.join(' ').slice(0, 48) : 'New Grade Chat';
}

/**
 * Have one of the pooled agents name the chat (like ChatGPT's sidebar auto-titler).
 * Uses the Token Mesh with a tiny token budget and falls back cleanly if needed.
 *
 * @param {string} userQuery
 * @param {string} [assistantReply]
 * @param {object} [options] { mesh?, course? }
 * @returns {Promise<{title: string, provider: string, model: string}>}
 */
export async function generateChatTitle(userQuery, assistantReply = '', options = {}) {
  if (typeof userQuery !== 'string' || userQuery.trim() === '') {
    throw new TypeError('generateChatTitle: userQuery must be a non-empty string');
  }
  const { mesh = getDefaultMesh(), course = '' } = options;
  const snippet = [
    course ? `Course: ${course}` : '',
    `Student: ${userQuery.trim().slice(0, 300)}`,
    assistantReply ? `Max: ${String(assistantReply).trim().slice(0, 300)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await mesh.complete({
      temperature: 0.2,
      messages: [
        { role: 'system', content: MAX_TITLE_PROMPT },
        { role: 'user', content: snippet },
      ],
    });
    return {
      title: cleanChatTitle(res.text, userQuery),
      provider: res.provider,
      model: res.model,
    };
  } catch {
    return {
      title: cleanChatTitle('', userQuery),
      provider: 'fallback',
      model: 'local',
    };
  }
}
