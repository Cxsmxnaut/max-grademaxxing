import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenMesh, DEFAULT_BENCH_MS } from '../src/tokenMesh.js';
import { createPool, PROVIDER_DEFAULTS } from '../src/config.js';

// ── helpers ─────────────────────────────────────────────────────────────

const tslot = (id, tier, provider = 'test') => ({
  id,
  tier,
  provider,
  key: `key-${id}`,
  model: 'm',
  baseUrl: 'https://unit.test/v1',
  headers: {},
});

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const okBody = (content) => ({ choices: [{ message: { content } }], usage: {} });

// just-under-1 random keeps Fisher-Yates order stable → deterministic expectations
const identityRandom = () => 0.9999999;

const recordingFetch = (behaviorFor) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = init.headers.authorization.replace('Bearer key-', '');
    calls.push(key);
    const behave = behaviorFor(key);
    if (behave === '429') return jsonResponse(429, {});
    if (behave === '500') return jsonResponse(500, {});
    return jsonResponse(200, okBody(`answer from ${key}`));
  };
  return { calls, fetchImpl };
};

// ── waterfall behaviour ─────────────────────────────────────────────────

test('tier 1 is tried before tier 2; a tier-1 success never touches tier 2', async () => {
  const { calls, fetchImpl } = recordingFetch(() => 'ok');
  const mesh = new TokenMesh({
    slots: [tslot('a', 1), tslot('b', 1), tslot('c', 2), tslot('d', 2)],
    fetchImpl,
    random: identityRandom,
  });

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'answer from a'); // first slot in tier-1 order
  assert.deepEqual(calls, ['a']); // tier 2 never called
});

test('429 on tier 1 fails over to the NEXT tier-1 key before any tier-2 slot', async () => {
  const { calls, fetchImpl } = recordingFetch((k) => (k === 'a' ? '429' : 'ok'));
  const mesh = new TokenMesh({
    slots: [tslot('a', 1), tslot('b', 1), tslot('c', 2), tslot('d', 2)],
    fetchImpl,
    random: identityRandom,
    benchJitterMs: 0,
  });

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'answer from b'); // tier-1 partner answered
  assert.deepEqual(calls, ['a', 'b']); // tier 2 untouched
  assert.equal(mesh.isBenched('a'), true); // 429 penalty applied

  // next request: benched 'a' skipped, healthy tier-1 'b' still primary
  await mesh.complete({ messages: [] });
  assert.deepEqual(calls, ['a', 'b', 'b']);
});

test('all tier-1 keys benched -> request goes straight to tier 2, no waiting', async () => {
  const { calls, fetchImpl } = recordingFetch(() => 'ok');
  const mesh = new TokenMesh({
    slots: [tslot('a', 1), tslot('b', 1), tslot('c', 2)],
    fetchImpl,
    random: identityRandom,
    sleep: () => {
      throw new Error('must not wait — tier 2 is available immediately');
    },
  });
  mesh.bench('a', 60_000);
  mesh.bench('b', 60_000);

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'answer from c');
  assert.deepEqual(calls, ['c']); // skipped straight over the benched tier
});

test('tier-1 outage (all 5xx) fails over to tier 2 WITHOUT benching tier-1 keys', async () => {
  const { calls, fetchImpl } = recordingFetch((k) => (k === 'a' || k === 'b' ? '500' : 'ok'));
  const mesh = new TokenMesh({
    slots: [tslot('a', 1), tslot('b', 1), tslot('c', 2)],
    fetchImpl,
    random: identityRandom,
  });

  const result = await mesh.complete({ messages: [] });
  assert.equal(result.text, 'answer from c');
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(mesh.isBenched('a'), false);
  assert.equal(mesh.isBenched('b'), false);
});

test('tier-1 keys split traffic evenly within the tier', async () => {
  const starts = { a: 0, b: 0 };
  const fetchImpl = async (url, init) => {
    starts[init.headers.authorization.replace('Bearer key-', '')]++;
    return jsonResponse(200, okBody('ok'));
  };
  const mesh = new TokenMesh({
    slots: [tslot('a', 1), tslot('b', 1), tslot('c', 2), tslot('d', 2), tslot('e', 2)],
    fetchImpl,
    random: Math.random,
  });

  for (let i = 0; i < 400; i++) await mesh.complete({ messages: [] });
  assert.equal((starts.c ?? 0) + (starts.d ?? 0) + (starts.e ?? 0), 0, 'tier 2 must never be called while tier 1 is healthy');
  assert.ok(starts.a > 140 && starts.b > 140, `even split expected, got a=${starts.a} b=${starts.b}`);
  assert.ok(Math.abs(starts.a - starts.b) < 120, `imbalance too high: a=${starts.a} b=${starts.b}`);
});

test('slots without an explicit tier keep plain-shuffle behaviour (tier 2 default)', async () => {
  const starts = {};
  const fetchImpl = async (url, init) => {
    const k = init.headers.authorization.replace('Bearer key-', '');
    starts[k] = (starts[k] ?? 0) + 1;
    return jsonResponse(200, okBody('ok'));
  };
  const mesh = new TokenMesh({
    slots: [tslot('x', undefined), tslot('y', undefined), tslot('z', undefined)],
    fetchImpl,
    random: Math.random,
  });
  for (let i = 0; i < 300; i++) await mesh.complete({ messages: [] });
  for (const k of ['x', 'y', 'z']) {
    assert.ok(starts[k] > 50, `untiered key ${k} underused: ${starts[k]}`);
  }
});

test('config wires gemini as Tier-1 and everything else as Tier-2', () => {
  const slots = createPool({
    gemini: ['g1', 'g2'],
    groq: ['q1'],
    openrouter: ['o1'],
    mistral: ['m1'],
  });
  const byId = Object.fromEntries(slots.map((s) => [s.id, s]));
  assert.equal(byId['gemini-1'].tier, 1);
  assert.equal(byId['gemini-2'].tier, 1);
  assert.equal(byId['groq-1'].tier, 2);
  assert.equal(byId['openrouter-1'].tier, 2);
  assert.equal(byId['mistral-1'].tier, 2);

  // duplicate provider keys in an object literal silently lose fields — this
  // exact bug once dropped gemini's tier, so assert the defaults are unique
  const providers = Object.keys(PROVIDER_DEFAULTS);
  assert.equal(new Set(providers).size, providers.length, 'PROVIDER_DEFAULTS has duplicate provider keys');
  assert.equal(PROVIDER_DEFAULTS.gemini.tier, 1);
});
