import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenMesh, UpstreamError, PoolExhaustedError, shuffle, DEFAULT_BENCH_MS } from '../src/tokenMesh.js';

// ── helpers ─────────────────────────────────────────────────────────────

const slot = (id, provider = 'groq') => ({
  id,
  provider,
  key: `key-${id}`,
  model: 'test-model',
  baseUrl: 'https://unit.test/v1',
  headers: {},
});

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const okBody = (content) => ({ model: 'test-model', choices: [{ message: { content } }], usage: { total_tokens: 5 } });

// random() just under 1 makes Fisher-Yates a no-op shuffle -> deterministic order.
const identityRandom = () => 0.9999999;

// deterministic PRNG for distribution tests (mulberry32)
function lcg(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── shuffle ─────────────────────────────────────────────────────────────

test('shuffle: permutation of input, input not mutated', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffle(input, lcg(42));
  assert.deepEqual([...out].sort((a, b) => a - b), input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('shuffle: distribution is roughly even across slots', () => {
  const slots = ['a', 'b', 'c', 'd'];
  const counts = Object.fromEntries(slots.map((s) => [s, 0]));
  const random = lcg(7);
  for (let i = 0; i < 2000; i++) counts[shuffle(slots, random)[0]]++;
  for (const s of slots) assert.ok(counts[s] > 350, `${s} got ${counts[s]} first-positions`);
});

// ── 429 handling (headline behaviour) ───────────────────────────────────

test('429: key is benched 60s and the exact same request instantly retries on the next key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = init.headers.authorization;
    calls.push({ url, key, body: JSON.parse(init.body) });
    if (key === 'Bearer key-a') return jsonResponse(429, { error: { message: 'rate limited' } });
    return jsonResponse(200, okBody(`answer from ${key}`));
  };

  const mesh = new TokenMesh({ slots: [slot('a'), slot('b')], fetchImpl, random: identityRandom });

  const result = await mesh.complete({ temperature: 0.3, messages: [{ role: 'user', content: '2+2' }] });

  assert.equal(result.text, 'answer from Bearer key-b');
  assert.deepEqual(
    calls.map((c) => c.key),
    ['Bearer key-a', 'Bearer key-b']
  );
  // identical payload on both attempts (only auth differs)
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(calls[0].url, calls[1].url);

  // key-a is now benched for ~60s
  assert.equal(mesh.isBenched('a'), true);
  assert.ok(mesh.benchRemaining('a') >= DEFAULT_BENCH_MS - 1000);
  assert.ok(mesh.benchRemaining('a') <= DEFAULT_BENCH_MS + 1100);

  // next request skips the benched key entirely (one call, not two)
  await mesh.complete({ temperature: 0.3, messages: [{ role: 'user', content: '3+3' }] });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].key, 'Bearer key-b');
});

test('429: all keys rate-limited -> waits out benches, then UpstreamError with per-attempt detail', async () => {
  const fetchImpl = async () => jsonResponse(429, { error: 'slow down' });
  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b'), slot('c')],
    fetchImpl,
    random: identityRandom,
    benchMs: 30, // short bench so the saturation retries stay fast in tests
    benchJitterMs: 0,
  });

  await assert.rejects(
    () => mesh.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.attempts.length, 3);
      assert.ok(err.attempts.every((a) => a.kind === 'rate_limit' && a.status === 429));
      assert.ok(err.attempts.every((a) => a.detail === '{"error":"slow down"}'));
      return true;
    }
  );
});

// ── bench-exhaustion behaviour ──────────────────────────────────────────

test('saturated pool: waits out the bench and completes on retry (user never errors)', async () => {
  let first = true;
  const fetchImpl = async () => {
    if (first) {
      first = false;
      return jsonResponse(429, {});
    }
    return jsonResponse(200, okBody('late success'));
  };
  const mesh = new TokenMesh({
    slots: [slot('a')], // single key: its 429 benches it, pool empties
    fetchImpl,
    random: identityRandom,
    benchMs: 60,
    benchJitterMs: 0,
    maxPoolWaitMs: 5_000,
  });

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'late success');
});

test('pool fully benched with zero wait budget: PoolExhaustedError immediately', async () => {
  const fetchImpl = async () => jsonResponse(429, {});
  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b')],
    fetchImpl,
    random: identityRandom,
    maxPoolWaitMs: 0,
  });
  await assert.rejects(() => mesh.complete({ messages: [] }), PoolExhaustedError);
});

// ── other failure classes ───────────────────────────────────────────────

test('5xx fails over WITHOUT benching the key', async () => {
  let first = true;
  const fetchImpl = async () => {
    if (first) {
      first = false;
      return jsonResponse(503, { error: 'overloaded' });
    }
    return jsonResponse(200, okBody('recovered'));
  };
  const mesh = new TokenMesh({ slots: [slot('a'), slot('b')], fetchImpl, random: identityRandom });

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'recovered');
  assert.equal(mesh.isBenched('a'), false);
});

test('401 dead key gets a long bench and fails over', async () => {
  const fetchImpl = async (url, init) =>
    init.headers.authorization === 'Bearer key-a'
      ? jsonResponse(401, { error: 'invalid api key' })
      : jsonResponse(200, okBody('ok'));
  const mesh = new TokenMesh({ slots: [slot('a'), slot('b')], fetchImpl, random: identityRandom, benchJitterMs: 0 });

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'ok');
  assert.ok(mesh.benchRemaining('a') > 9 * 60_000); // ~10 min penalty
});

test('network errors fail over without benching', async () => {
  let first = true;
  const fetchImpl = async () => {
    if (first) {
      first = false;
      throw new TypeError('fetch failed');
    }
    return jsonResponse(200, okBody('second key works'));
  };
  const mesh = new TokenMesh({ slots: [slot('a'), slot('b')], fetchImpl, random: identityRandom });

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'second key works');
  assert.equal(mesh.isBenched('a'), false);
});

test('per-provider model is injected into the outgoing payload', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, model: JSON.parse(init.body).model });
    return jsonResponse(200, okBody('yep'));
  };
  const slots = [
    { ...slot('g', 'groq'), model: 'groq-model', baseUrl: 'https://groq.test/v1' },
    { ...slot('o', 'openrouter'), model: 'or-model', baseUrl: 'https://or.test/v1/' },
    { ...slot('m', 'mistral'), model: 'mistral-model', baseUrl: 'https://mistral.test/v1' },
  ];
  const mesh = new TokenMesh({ slots, fetchImpl, random: identityRandom });
  await mesh.complete({ messages: [], temperature: 0.3 });

  assert.deepEqual(seen[0], { url: 'https://groq.test/v1/chat/completions', model: 'groq-model' }); // identity shuffle keeps slot order
});

test('constructor rejects empty pools and malformed slots', () => {
  assert.throws(() => new TokenMesh({ slots: [] }), TypeError);
  assert.throws(() => new TokenMesh({ slots: [{ provider: 'groq' }] }), TypeError);
});

test('onEvent hook sees bench/failover/success without breaking routing', async () => {
  const events = [];
  let first = true;
  const fetchImpl = async () => {
    if (first) {
      first = false;
      return jsonResponse(429, {});
    }
    return jsonResponse(200, okBody('done'));
  };
  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b')],
    fetchImpl,
    random: identityRandom,
    onEvent: (e) => {
      events.push(e.type);
      throw new Error('observer must not break routing');
    },
  });
  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'done');
  assert.ok(events.includes('failover'));
  assert.ok(events.includes('bench'));
  assert.ok(events.includes('success'));
});
