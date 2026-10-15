import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenMesh } from '../src/tokenMesh.js';

// Tier 1 / tier 2 forces a deterministic waterfall (one slot per tier), so
// tests never depend on the within-tier shuffle.
const slot = (id, provider = 'groq', tier = 1) => ({
  id,
  provider,
  key: `key-${id}`,
  model: 'test-model',
  baseUrl: 'https://provider.test/v1',
  tier,
});

const sse = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content) => frame({ choices: [{ delta: { content } }] });

/**
 * fetch mock routing by the request's Authorization key ('key-s1', …) so
 * behaviour is independent of shuffling. Each route is a function (or list
 * of functions consumed per attempt against that key):
 *   mockFetch({ 'key-s1': () => new Response(..., {status:429}),
 *               'key-s2': () => sse(delta('ok')) })
 */
function mockFetch(routes) {
  const calls = [];
  const seen = new Map();
  const fetchImpl = async (url, opts) => {
    const key = String(opts.headers.authorization ?? '').replace('Bearer ', '');
    calls.push({ url, opts, body: JSON.parse(opts.body), key });
    const route = routes[key];
    if (!route) throw new Error(`unexpected provider key: ${key}`);
    const list = Array.isArray(route) ? route : [route];
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return list[Math.min(n, list.length - 1)](url, opts, n);
  };
  return { calls, fetchImpl };
}

const payload = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 };

// ── happy path ─────────────────────────────────────────────────────────

test('completeStream pumps SSE deltas through onToken and assembles the result', async () => {
  const body = delta('Hel') + delta('lo') + frame({ choices: [], usage: { total_tokens: 5 } }) + 'data: [DONE]\n\n';
  const { calls, fetchImpl } = mockFetch({ 'key-s1': () => sse(body) });
  const mesh = new TokenMesh({ slots: [slot('s1')], fetchImpl, random: () => 0 });

  const chunks = [];
  const result = await mesh.completeStream(payload, (c) => chunks.push(c));

  assert.deepEqual(chunks, ['Hel', 'lo']);
  assert.equal(result.text, 'Hello');
  assert.equal(result.slotId, 's1');
  assert.deepEqual(result.usage, { total_tokens: 5 });
  // the outgoing request asked for a stream
  assert.equal(calls[0].body.stream, true);
  // model still injected per-slot, payload otherwise untouched
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(calls[0].body.temperature, 0.3);
});

test('multi-byte tokens split across SSE frames are reassembled losslessly', async () => {
  const body = delta('café ☕ ') + delta('naïve');
  const { fetchImpl } = mockFetch({ 'key-s1': () => sse(body) });
  const mesh = new TokenMesh({ slots: [slot('s1')], fetchImpl, random: () => 0 });

  const chunks = [];
  const result = await mesh.completeStream(payload, (c) => chunks.push(c));
  assert.equal(result.text, 'café ☕ naïve');
  assert.equal(chunks.join(''), 'café ☕ naïve');
});

// ── failover happens BEFORE the first token ────────────────────────────

test('429 fails over instantly: only the second key ever reaches onToken', async () => {
  const { calls, fetchImpl } = mockFetch({
    'key-s1': () => new Response('slow down', { status: 429 }),
    'key-s2': () => sse(delta('second key answer') + 'data: [DONE]\n\n'),
  });
  const mesh = new TokenMesh({ slots: [slot('s1', 'groq', 1), slot('s2', 'groq', 2)], fetchImpl, random: () => 0 });

  const chunks = [];
  const result = await mesh.completeStream(payload, (c) => chunks.push(c));

  assert.equal(calls.length, 2);
  assert.equal(result.text, 'second key answer');
  assert.equal(chunks.join(''), 'second key answer'); // no 429 garbage in the stream
  assert.equal(mesh.isBenched('s1'), true); // rate-limited key benched
  assert.equal(mesh.isBenched('s2'), false);
});

test('dead key (401) fails over without delivering any token', async () => {
  const { fetchImpl } = mockFetch({
    'key-s1': () => new Response('bad key', { status: 401 }),
    'key-s2': () => sse(delta('recovered') + 'data: [DONE]\n\n'),
  });
  const mesh = new TokenMesh({ slots: [slot('s1', 'groq', 1), slot('s2', 'groq', 2)], fetchImpl, random: () => 0 });

  const chunks = [];
  const result = await mesh.completeStream(payload, (c) => chunks.push(c));
  assert.equal(result.text, 'recovered');
  assert.deepEqual(chunks, ['recovered']);
  assert.ok(mesh.benchRemaining('s1') > 0);
});

test('pre-token network failure fails over like complete() does', async () => {
  const { fetchImpl } = mockFetch({
    'key-s1': () => {
      throw new TypeError('fetch failed');
    },
    'key-s2': () => sse(delta('after blip') + 'data: [DONE]\n\n'),
  });
  const mesh = new TokenMesh({ slots: [slot('s1', 'groq', 1), slot('s2', 'groq', 2)], fetchImpl, random: () => 0 });

  const result = await mesh.completeStream(payload, () => {});
  assert.equal(result.text, 'after blip');
  assert.equal(mesh.isBenched('s1'), false); // network errors are not benched
});

// ── mid-stream interruption ────────────────────────────────────────────

test('stream break AFTER tokens were delivered throws — no answer is spliced from another key', async () => {
  // pull(): first read delivers a real token, second read errors the
  // stream — mirroring a connection that dies mid-answer.
  let pulls = 0;
  const brokenStream = () => {
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode(delta('partial answer ')));
        else controller.error(new Error('connection reset'));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { calls, fetchImpl } = mockFetch({
    'key-s1': brokenStream,
    'key-s2': () => sse(delta('a COMPLETELY different answer from key 2') + 'data: [DONE]\n\n'),
  });
  const mesh = new TokenMesh({ slots: [slot('s1', 'groq', 1), slot('s2', 'groq', 2)], fetchImpl, random: () => 0 });

  const chunks = [];
  await assert.rejects(
    () => mesh.completeStream(payload, (c) => chunks.push(c)),
    (err) => {
      assert.equal(err.name, 'UpstreamError');
      assert.match(err.message, /stream interrupted/i);
      return true;
    }
  );
  // the caller saw partial tokens, and never the second key's answer
  assert.equal(chunks.join(''), 'partial answer ');
  assert.equal(calls.length, 1); // key-s2 was never attempted
});

// ── all keys failing pre-token surfaces the usual errors ───────────────

test('every key failing before a token raises UpstreamError with attempts', async () => {
  const { fetchImpl } = mockFetch({
    'key-s1': () => new Response('rate', { status: 429 }),
    'key-s2': () => new Response('server exploded', { status: 500 }),
  });
  const mesh = new TokenMesh({ slots: [slot('s1', 'groq', 1), slot('s2', 'groq', 2)], fetchImpl, random: () => 0 });

  await assert.rejects(
    () => mesh.completeStream(payload, () => {}),
    (err) => {
      assert.equal(err.name, 'UpstreamError');
      assert.equal(err.attempts.length, 2);
      return true;
    }
  );
});

// ── provider quirks ────────────────────────────────────────────────────

test('provider ignoring stream:true (plain JSON body) is salvaged as one chunk', async () => {
  const jsonBody = JSON.stringify({
    model: 'm',
    choices: [{ message: { content: 'not streaming' } }],
    usage: { total_tokens: 3 },
  });
  const { fetchImpl } = mockFetch({
    'key-s1': () => new Response(jsonBody, { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const mesh = new TokenMesh({ slots: [slot('s1')], fetchImpl, random: () => 0 });

  const chunks = [];
  const result = await mesh.completeStream(payload, (c) => chunks.push(c));
  assert.equal(result.text, 'not streaming');
  assert.deepEqual(chunks, ['not streaming']);
  assert.deepEqual(result.usage, { total_tokens: 3 });
});

test('non-SSE response with no body reader uses the json fallback', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: undefined,
    json: async () => ({ choices: [{ message: { content: 'bodyless' } }], model: 'm2', usage: null }),
  });
  const mesh = new TokenMesh({ slots: [slot('s1')], fetchImpl, random: () => 0 });

  const chunks = [];
  const result = await mesh.completeStream(payload, (c) => chunks.push(c));
  assert.equal(result.text, 'bodyless');
  assert.equal(result.model, 'm2');
  assert.deepEqual(chunks, ['bodyless']);
});

// ── argument validation ────────────────────────────────────────────────

test('completeStream validates payload and onToken before touching the network', async () => {
  const { calls, fetchImpl } = mockFetch({ 'key-s1': () => sse('') });
  const mesh = new TokenMesh({ slots: [slot('s1')], fetchImpl, random: () => 0 });

  await assert.rejects(() => mesh.completeStream({}, () => {}), TypeError);
  await assert.rejects(() => mesh.completeStream(payload), TypeError);
  await assert.rejects(() => mesh.completeStream(payload, 'not a function'), TypeError);
  assert.equal(calls.length, 0);
});
