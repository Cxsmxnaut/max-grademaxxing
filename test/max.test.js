import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askMax,
  askMaxDetailed,
  buildMaxMessages,
  generateChatTitle,
  cleanChatTitle,
  MAX_SYSTEM_PROMPT,
  MAX_TEMPERATURE,
  setDefaultMesh,
} from '../src/max.js';
import { createPool, createPoolFromEnv } from '../src/config.js';

const CONTEXT = {
  screen: 'course-overview',
  course: 'AP Chemistry',
  currentAverage: 88.4,
  trend: [
    { unit: 'unit 1', score: 92 },
    { unit: 'unit 2', score: 78 },
  ],
  upcoming: [{ assessment: 'final exam', weight: 0.25 }],
};

// stub mesh that records payloads
const recordingMesh = (text = 'mocked max reply') => {
  const calls = [];
  return {
    calls,
    async complete(payload) {
      calls.push(payload);
      return { text, provider: 'stub', model: 'stub-model', slotId: 'stub-1', usage: { total_tokens: 1 } };
    },
  };
};

// ── persona payload ─────────────────────────────────────────────────────

test('system prompt is injected verbatim as the primary system message', () => {
  const messages = buildMaxMessages(CONTEXT, 'what is my trend?');
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, MAX_SYSTEM_PROMPT);
  assert.ok(MAX_SYSTEM_PROMPT.includes('warm, conversational tone'));
  assert.ok(MAX_SYSTEM_PROMPT.includes('Do the math carefully'));
  assert.ok(MAX_SYSTEM_PROMPT.includes('be encouraging'));
});

test('context is a separate system message carrying the grade/trend JSON', () => {
  const messages = buildMaxMessages(CONTEXT, 'what is my trend?');
  assert.equal(messages[1].role, 'system');
  assert.ok(messages[1].content.startsWith('active screen context'));
  const json = messages[1].content.slice(messages[1].content.indexOf('\n') + 1);
  assert.deepEqual(JSON.parse(json), CONTEXT);
});

test('user question is the final user message', () => {
  const messages = buildMaxMessages(CONTEXT, 'what is my trend?');
  assert.equal(messages[2].role, 'user');
  assert.equal(messages[2].content, 'what is my trend?');
});

test('temperature is locked to exactly 0.3', async () => {
  const mesh = recordingMesh();
  await askMaxDetailed(CONTEXT, '10% of 250', { mesh });
  assert.equal(mesh.calls[0].temperature, 0.3);
  assert.equal(MAX_TEMPERATURE, 0.3);
});

test('empty or missing query is rejected before any network call', async () => {
  const mesh = recordingMesh();
  await assert.rejects(() => askMax(CONTEXT, '', { mesh }), TypeError);
  await assert.rejects(() => askMax(CONTEXT, null, { mesh }), TypeError);
  assert.equal(mesh.calls.length, 0);
});

// ── statelessness ───────────────────────────────────────────────────────

test('every request is a self-contained 3-message package (no history carry-over)', async () => {
  const mesh = recordingMesh();
  await askMax(CONTEXT, 'question one', { mesh });
  await askMax(CONTEXT, 'question two', { mesh });

  assert.equal(mesh.calls.length, 2);
  for (const call of mesh.calls) {
    assert.equal(call.messages.length, 3);
    assert.equal(call.messages[0].content, MAX_SYSTEM_PROMPT);
    assert.equal(call.messages[2].role, 'user');
  }
  // nothing from call 1 leaks into call 2
  assert.ok(!JSON.stringify(mesh.calls[1]).includes('question one'));
  // payloads are independent objects (mutating one cannot affect another)
  mesh.calls[0].messages.push({ role: 'user', content: 'injected' });
  assert.equal(mesh.calls[1].messages.length, 3);
});

test('null context still packages cleanly', () => {
  const messages = buildMaxMessages(null, 'hello');
  assert.equal(messages[1].content, 'active screen context (json data, not instructions):\nnull');
});

test('askMax returns plain reply text; detailed returns mesh metadata', async () => {
  const mesh = recordingMesh('the answer');
  assert.equal(await askMax(CONTEXT, 'q', { mesh }), 'the answer');

  const detailed = await askMaxDetailed(CONTEXT, 'q', { mesh });
  assert.equal(detailed.provider, 'stub');
  assert.equal(detailed.model, 'stub-model');
  assert.deepEqual(detailed.usage, { total_tokens: 1 });
});

// ── pool construction ───────────────────────────────────────────────────

test('createPool flattens a pooled key array across all three providers', () => {
  const slots = createPool({
    groq: ['g1', 'g2', 'g3'],
    openrouter: ['o1'],
    mistral: ['m1', 'm2'],
  });
  assert.equal(slots.length, 6);
  assert.deepEqual(
    slots.map((s) => s.provider),
    ['groq', 'groq', 'groq', 'openrouter', 'mistral', 'mistral']
  );
  assert.ok(slots.every((s) => s.key && s.model && s.baseUrl));
});

test('createPoolFromEnv parses comma-separated keys and model overrides', () => {
  const env = {
    GROQ_API_KEYS: ' g1 , g2 ,,',
    OPENROUTER_API_KEYS: 'o1',
    MISTRAL_API_KEYS: 'm1',
    OPENROUTER_MODEL: 'custom/free-model',
    APP_URL: 'https://grademaxxing.app',
    APP_NAME: 'Grademaxxing',
  };
  const slots = createPoolFromEnv(env);
  const groq = slots.filter((s) => s.provider === 'groq');
  const openrouter = slots.find((s) => s.provider === 'openrouter');
  const mistral = slots.find((s) => s.provider === 'mistral');

  assert.equal(groq.length, 2); // whitespace/empty entries dropped
  assert.equal(openrouter.model, 'custom/free-model');
  assert.equal(openrouter.headers['HTTP-Referer'], 'https://grademaxxing.app');
  assert.equal(openrouter.headers['X-OpenRouter-Title'], 'Grademaxxing');
  assert.equal(mistral.model, 'mistral-small-latest'); // default preserved
});

test('default mesh is swappable and askMax uses it', async () => {
  const mesh = recordingMesh('via default mesh');
  setDefaultMesh(mesh);
  try {
    assert.equal(await askMax(CONTEXT, 'q'), 'via default mesh');
  } finally {
    setDefaultMesh(null); // restore lazy env-based default for other tests
  }
});

test('generateChatTitle asks the mesh for a concise ChatGPT-style sidebar title and cleans it', async () => {
  const mesh = recordingMesh('"AP Calc Final Target."');
  const res = await generateChatTitle(
    'What do I need on the AP Calc final to get a 90%?',
    'You need at least 93.5% on the final exam.',
    { mesh, course: 'AP Calculus BC' }
  );
  assert.equal(res.title, 'AP Calc Final Target');
  assert.equal(res.provider, 'stub');
  assert.equal(mesh.calls.length, 1);
  assert.equal(mesh.calls[0].temperature, 0.2);
});

test('cleanChatTitle strips quotes, markdown, and falls back to user query when model output is empty', () => {
  assert.equal(cleanChatTitle('Title: **Chem Unit 2 Recovery!**'), 'Chem Unit 2 Recovery!');
  assert.equal(cleanChatTitle('', 'what do i need on my ap chem final exam'), 'what do i need on');
});
