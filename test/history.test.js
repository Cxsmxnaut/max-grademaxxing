import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askMaxDetailed,
  buildMaxMessages,
  MAX_SYSTEM_PROMPT,
  MAX_HISTORY_TURNS,
} from '../src/max.js';

const CONTEXT = { screen: 'course-overview', course: 'AP Chemistry', currentAverage: 88.4 };

const recordingMesh = () => {
  const calls = [];
  return {
    calls,
    async complete(payload) {
      calls.push(payload);
      return { text: 'ok', provider: 'stub', model: 'stub-model', slotId: 'stub-1', usage: null };
    },
  };
};

// ── history packaging ──────────────────────────────────────────────────

test('history turns are inserted between the context and the final user question', () => {
  const messages = buildMaxMessages(CONTEXT, 'and what about the final?', [
    { role: 'user', text: 'what is my average?' },
    { role: 'max', text: 'Your average is 88.4.' },
  ]);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].role, 'system'); // persona
  assert.equal(messages[1].role, 'system'); // context
  assert.deepEqual(messages[2], { role: 'user', content: 'what is my average?' });
  assert.deepEqual(messages[3], { role: 'assistant', content: 'Your average is 88.4.' });
  assert.equal(messages[4].role, 'user'); // question always last
  assert.equal(messages[4].content, 'and what about the final?');
});

test("UI roles are normalized: 'max' becomes assistant, 'user' stays user", () => {
  const messages = buildMaxMessages(null, 'q', [
    { role: 'max', text: 'max said this' },
    { role: 'assistant', text: 'already canonical' },
    { role: 'user', text: 'user said this' },
  ]);
  assert.deepEqual(
    messages.slice(2, 5).map((m) => [m.role, m.content]),
    [
      ['assistant', 'max said this'],
      ['assistant', 'already canonical'],
      ['user', 'user said this'],
    ]
  );
});

test('malformed history entries are dropped, never thrown', () => {
  const messages = buildMaxMessages(null, 'q', [
    null,
    'not an object',
    { role: 'system', text: 'role injection' }, // only user/assistant allowed
    { role: 'user' }, // no text
    { role: 'user', text: '   ' }, // empty after trim
    { role: 'narrator', text: 'unknown role' },
    { role: 'user', text: 'keeps this one' },
  ]);
  // only the one valid entry survives: 2 system + 1 turn + final question
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[2], { role: 'user', content: 'keeps this one' });
  assert.equal(messages[3].content, 'q');
});

test('non-array history is ignored instead of breaking the request', () => {
  assert.equal(buildMaxMessages(null, 'q', { role: 'user', text: 'sneaky' }).length, 3);
  assert.equal(buildMaxMessages(null, 'q', 'history-as-string').length, 3);
  assert.equal(buildMaxMessages(null, 'q', null).length, 3);
});

test('history is bounded: last MAX_HISTORY_TURNS turns, each capped at 1500 chars', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `turn ${i} ${'x'.repeat(3000)}` }));
  const messages = buildMaxMessages(null, 'q', many);
  const turns = messages.slice(2, -1);
  assert.equal(turns.length, MAX_HISTORY_TURNS);
  assert.ok(turns.every((t) => t.content.length === 1500));
  // the OLDEST turns are the ones dropped — turn 0 must be gone
  assert.ok(!JSON.stringify(turns).includes('turn 0 '));
});

test('empty or omitted history keeps the original 3-message stateless package', () => {
  assert.equal(buildMaxMessages(CONTEXT, 'q').length, 3);
  assert.equal(buildMaxMessages(CONTEXT, 'q', []).length, 3);
  assert.equal(buildMaxMessages(CONTEXT, 'q', [{}]).length, 3);
});

// ── history pass-through in askMaxDetailed ─────────────────────────────

test('askMaxDetailed forwards history into the mesh payload', async () => {
  const mesh = recordingMesh();
  await askMaxDetailed(CONTEXT, 'next question', {
    mesh,
    history: [{ role: 'user', text: 'previous question' }, { role: 'max', text: 'previous answer' }],
  });
  const messages = mesh.calls[0].messages;
  assert.equal(messages.length, 5);
  assert.equal(messages[2].content, 'previous question');
  assert.equal(messages[3].role, 'assistant');
});

test('with no history the payload is byte-identical to the stateless package', async () => {
  const mesh = recordingMesh();
  await askMaxDetailed(CONTEXT, 'q', { mesh });
  const messages = mesh.calls[0].messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[2].content, 'q');
});

// ── #7 markdown guidance ───────────────────────────────────────────────

test('system prompt tells Max to use the markdown the UI now renders', () => {
  assert.ok(MAX_SYSTEM_PROMPT.includes('**bold**'));
  assert.ok(MAX_SYSTEM_PROMPT.includes('bulleted'));
  assert.ok(MAX_SYSTEM_PROMPT.includes('`inline code`'));
  // guardrails survive: tone + math instructions still present
  assert.ok(MAX_SYSTEM_PROMPT.includes('warm, conversational tone'));
  assert.ok(MAX_SYSTEM_PROMPT.includes('Do the math carefully'));
});
