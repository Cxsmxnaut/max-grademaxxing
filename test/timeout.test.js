import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenMesh, UpstreamError, DEFAULT_BENCH_MS } from '../src/tokenMesh.js';

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

const identityRandom = () => 0.9999999;

const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/** fetch that never answers and only rejects when its signal aborts. */
const hangingFetch = () => (url, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });

const sseBody = (frames) => {
  const payload = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const deltaFrame = (t) => ({ choices: [{ delta: { content: t } }] });

/** Streaming fetch whose reader hangs until the signal aborts. */
const silentStreamFetch = () => (url, init) =>
  Promise.resolve({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          }),
      }),
    },
  });

/** Streaming fetch: first read delivers one token, later reads hang. */
const stallsAfterFirstTokenFetch = () => (url, init) => {
  let reads = 0;
  const encoder = new TextEncoder();
  return Promise.resolve({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (reads++ === 0) {
            const value = encoder.encode('data: {"choices":[{"delta":{"content":"partial "}}]}\n\n');
            return Promise.resolve({ done: false, value });
          }
          return new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        },
      }),
    },
  });
};

/** Streaming fetch: scripted chunks, each read delayed by gapMs. */
const pacedStreamFetch = (chunks, gapMs) => {
  const encoder = new TextEncoder();
  return (url) => {
    let i = 0;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            const value = encoder.encode(`data: ${JSON.stringify(deltaFrame(chunks[i++]))}\n\n`);
            return new Promise((resolve) => setTimeout(() => resolve({ done: false, value }), gapMs));
          },
        }),
      },
    });
  };
};

const payload = { temperature: 0.3, messages: [{ role: 'user', content: 'hi' }] };

// ── non-stream attempt timeout ──────────────────────────────────────────

test('hung key: aborted within attemptTimeoutMs, benched 60s, next key answers', async () => {
  const calls = [];
  const fetchImpl = (url, init) => {
    const key = init.headers.authorization;
    calls.push(key);
    if (key === 'Bearer key-a') return hangingFetch()(url, init);
    return Promise.resolve(jsonResponse(200, okBody('second key wins')));
  };

  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b')],
    fetchImpl,
    random: identityRandom,
    attemptTimeoutMs: 40,
  });

  const started = Date.now();
  const result = await mesh.complete(payload);
  const elapsed = Date.now() - started;

  assert.equal(result.text, 'second key wins');
  assert.ok(elapsed < 5_000, `must not wait for the default 20s (took ${elapsed}ms)`);
  assert.deepEqual(calls, ['Bearer key-a', 'Bearer key-b']);

  // timeout benches the silent key like a rate limit — next request skips it
  assert.equal(mesh.isBenched('a'), true);
  assert.ok(mesh.benchRemaining('a') >= DEFAULT_BENCH_MS - 1000);
  assert.ok(mesh.benchRemaining('a') <= DEFAULT_BENCH_MS + 1100);
  assert.equal(mesh.isBenched('b'), false);
});

test('every key hanging: UpstreamError with per-attempt kind "timeout" (no stall, no bench-wait)', async () => {
  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b')],
    fetchImpl: hangingFetch(),
    random: identityRandom,
    attemptTimeoutMs: 30,
  });

  const started = Date.now();
  await assert.rejects(
    mesh.complete(payload),
    (err) =>
      err instanceof UpstreamError &&
      err.attempts.length === 2 &&
      err.attempts.every((a) => a.kind === 'timeout')
  );
  assert.ok(Date.now() - started < 5_000, 'must fail fast instead of hanging');
});

test('attemptTimeoutMs: 0 disables the non-stream timeout (hang behaves as before)', async () => {
  // The hanging attempt is aborted manually after proving no timer fired early.
  let sawSignal;
  const fetchImpl = (url, init) => {
    sawSignal = init.signal;
    return new Promise((resolve) => setTimeout(() => resolve(jsonResponse(200, okBody('slow ok'))), 60));
  };
  const mesh = new TokenMesh({
    slots: [slot('a')],
    fetchImpl,
    attemptTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
  });

  const result = await mesh.complete(payload);
  assert.equal(result.text, 'slow ok');
  assert.equal(sawSignal?.aborted, false, 'no abort timer must be armed when disabled');
});

// ── stream timeouts ─────────────────────────────────────────────────────

test('silent stream: headers arrive but no chunks -> idle timeout benches key, failover streams tokens', async () => {
  const calls = [];
  const fetchImpl = (url, init) => {
    const key = init.headers.authorization;
    calls.push(key);
    if (key === 'Bearer key-a') return silentStreamFetch()(url, init);
    return Promise.resolve(sseBody([deltaFrame('hello '), deltaFrame('world')]));
  };

  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b')],
    fetchImpl,
    random: identityRandom,
    streamIdleTimeoutMs: 40,
  });

  const tokens = [];
  const started = Date.now();
  const result = await mesh.completeStream(payload, (t) => tokens.push(t));
  const elapsed = Date.now() - started;

  assert.equal(result.text, 'hello world');
  assert.equal(tokens.join(''), 'hello world');
  assert.ok(elapsed < 5_000, `silent key must be cut off quickly (took ${elapsed}ms)`);
  assert.deepEqual(calls, ['Bearer key-a', 'Bearer key-b']);
  assert.equal(mesh.isBenched('a'), true, 'silent stream key is benched');
  assert.ok(mesh.benchRemaining('a') >= DEFAULT_BENCH_MS - 1000);
});

test('mid-stream stall after a token: UpstreamError (partial), second key NOT called', async () => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push(init.headers.authorization);
    return stallsAfterFirstTokenFetch()(url, init);
  };

  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b')],
    fetchImpl,
    random: identityRandom,
    streamIdleTimeoutMs: 40,
  });

  const tokens = [];
  await assert.rejects(
    mesh.completeStream(payload, (t) => tokens.push(t)),
    (err) => err instanceof UpstreamError && /stream interrupted mid-answer/.test(err.message)
  );
  assert.deepEqual(tokens, ['partial '], 'the delivered token stands');
  assert.deepEqual(calls, ['Bearer key-a'], 'a partial answer must never be stitched from a second key');
});

test('flowing stream below the idle deadline is never aborted', async () => {
  const mesh = new TokenMesh({
    slots: [slot('a')],
    fetchImpl: pacedStreamFetch(['one ', 'two ', 'three'], 15),
    streamIdleTimeoutMs: 150,
  });

  const tokens = [];
  const result = await mesh.completeStream(payload, (t) => tokens.push(t));
  assert.equal(result.text, 'one two three');
  assert.equal(tokens.length, 3);
  assert.equal(mesh.isBenched('a'), false, 'healthy streaming key must not be benched');
});

// ── observability ───────────────────────────────────────────────────────

test('onEvent sees the failover with reason "timeout"', async () => {
  const events = [];
  const fetchImpl = (url, init) =>
    init.headers.authorization === 'Bearer key-a'
      ? hangingFetch()(url, init)
      : Promise.resolve(jsonResponse(200, okBody('ok')));

  const mesh = new TokenMesh({
    slots: [slot('a'), slot('b')],
    fetchImpl,
    random: identityRandom,
    attemptTimeoutMs: 30,
    onEvent: (e) => events.push(e),
  });

  await mesh.complete(payload);
  const failover = events.find((e) => e.type === 'failover' && e.slotId === 'a');
  assert.ok(failover, 'failover event emitted');
  assert.equal(failover.reason, 'timeout');
  assert.ok(events.some((e) => e.type === 'bench' && e.slotId === 'a'));
  assert.ok(events.some((e) => e.type === 'success' && e.slotId === 'b'));
});
