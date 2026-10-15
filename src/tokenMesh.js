/**
 * tokenMesh.js — THE MODEL SWITCHER ENGINE ("Token Mesh")
 *
 * A dependency-free router that spreads chat traffic across a pooled array of
 * free-tier provider keys (Groq, OpenRouter, Mistral — anything OpenAI-compatible).
 *
 * Behaviour per incoming request:
 *   1. Waterfall order: Tier-1 slots first (shuffled within the tier), then
 *      Tier-2, etc. — see orderWaterfall(). Benched slots are excluded.
 *   2. Try slots in that order with native fetch.
 *   3. HTTP 429 (rate limit)  -> bench that key for 60s (+ jitter) and INSTANTLY
 *      retry the exact same request on the next key. The caller never sees it.
 *   4. HTTP 401/403 (dead key) -> bench 10 min, fail over to the next key.
 *   5. HTTP 5xx / network drop -> fail over to the next key without benching.
 *   6. Every key benched       -> wait for the shortest bench to expire
 *      (bounded by maxPoolWaitMs) instead of failing the user.
 *
 * The mesh is stateless with respect to conversations: it only ever tracks
 * per-key bench timers. No message history is stored, ever.
 */

export const DEFAULT_BENCH_MS = 60_000; // 60 seconds, per spec
export const DEFAULT_BENCH_JITTER_MS = 1_000; // avoids thundering-herd retries
export const INVALID_KEY_BENCH_MS = 10 * 60_000; // 401/403 keys get a longer penalty
export const DEFAULT_MAX_POOL_WAIT_MS = 120_000;

export class PoolExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

export class UpstreamError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = 'UpstreamError';
    this.attempts = attempts; // one entry per failed slot: { slotId, provider, kind, status }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fisher-Yates shuffle; returns a new array, never mutates the input. */
export function shuffle(array, random = Math.random) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const randomId = () => Math.random().toString(36).slice(2, 10);

/**
 * Waterfall ordering: tiers ascending, shuffled within each tier. Keys of the
 * same tier split traffic evenly; failover walks down the tiers — e.g. two
 * Tier-1 Gemini keys alternate, and only when all Tier-1 keys fail or are
 * benched does the request reach Tier-2 (OpenRouter/Groq). Slots without an
 * explicit tier default to 2, preserving plain-shuffle behaviour.
 */
function orderWaterfall(slots, random = Math.random) {
  const tiers = new Map();
  for (const slot of slots) {
    const tier = slot.tier ?? 2;
    if (!tiers.has(tier)) tiers.set(tier, []);
    tiers.get(tier).push(slot);
  }
  return [...tiers.keys()]
    .sort((a, b) => a - b)
    .flatMap((tier) => shuffle(tiers.get(tier), random));
}
const truncate = (s, n = 300) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

export class TokenMesh {
  /**
   * @param {object} opts
   * @param {Array<{provider: string, key: string, model: string, baseUrl: string, id?: string, headers?: object}>} opts.slots
   * @param {number}   [opts.benchMs=60000]        429 penalty duration
   * @param {number}   [opts.benchJitterMs=1000]   random extra added to each bench
   * @param {number}   [opts.invalidKeyBenchMs=600000] penalty for 401/403
   * @param {number}   [opts.maxPoolWaitMs=120000] max time to wait when all keys are benched
   * @param {Function} [opts.fetchImpl=fetch]      injectable for tests
   * @param {Function} [opts.random=Math.random]   injectable for deterministic shuffles
   * @param {Function} [opts.sleep]                injectable for tests
   * @param {Function} [opts.onEvent]              observability hook ({type, ...}) — never throws upstream
   */
  constructor({
    slots,
    benchMs = DEFAULT_BENCH_MS,
    benchJitterMs = DEFAULT_BENCH_JITTER_MS,
    invalidKeyBenchMs = INVALID_KEY_BENCH_MS,
    maxPoolWaitMs = DEFAULT_MAX_POOL_WAIT_MS,
    fetchImpl = globalThis.fetch,
    random = Math.random,
    sleep = defaultSleep,
    onEvent = null,
  } = {}) {
    if (!Array.isArray(slots) || slots.length === 0) {
      throw new TypeError('TokenMesh requires a non-empty array of key slots');
    }
    for (const slot of slots) {
      if (!slot || typeof slot.key !== 'string' || slot.key === '' || !slot.baseUrl) {
        throw new TypeError(`TokenMesh: invalid key slot -> ${JSON.stringify(slot)}`);
      }
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('TokenMesh: fetchImpl must be a function (global fetch is missing)');
    }

    this.slots = slots.map((slot, i) => ({
      headers: {},
      ...slot,
      id: slot.id ?? `${slot.provider ?? 'provider'}-${i + 1}`,
    }));
    this.benchMs = benchMs;
    this.benchJitterMs = benchJitterMs;
    this.invalidKeyBenchMs = invalidKeyBenchMs;
    this.maxPoolWaitMs = maxPoolWaitMs;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.sleep = sleep;
    this.onEvent = onEvent;

    this._benches = new Map(); // slotId -> epoch ms when the bench expires
  }

  // ── bench bookkeeping ────────────────────────────────────────────────

  bench(slotId, ms = this.benchMs) {
    const jitter = this.benchJitterMs > 0 ? Math.floor(this.random() * this.benchJitterMs) : 0;
    this._benches.set(slotId, Date.now() + ms + jitter);
    this._emit({ type: 'bench', slotId, ms: ms + jitter });
  }

  benchRemaining(slotId, now = Date.now()) {
    const until = this._benches.get(slotId);
    return until ? Math.max(0, until - now) : 0;
  }

  isBenched(slotId, now = Date.now()) {
    return this.benchRemaining(slotId, now) > 0;
  }

  clearBench(slotId) {
    this._benches.delete(slotId);
  }

  resetBenches() {
    this._benches.clear();
  }

  availableSlots(now = Date.now()) {
    return this.slots.filter((slot) => !this.isBenched(slot.id, now));
  }

  // ── routing ──────────────────────────────────────────────────────────

  /**
   * Route one OpenAI-style chat payload through the pool.
   * The payload is never mutated; each attempt re-serializes it with the
   * slot's model, so every retry is the exact same request.
   *
   * @returns {Promise<{text: string, provider: string, model: string, slotId: string, usage: object|null}>}
   */
  async complete(payload, _depth = 0) {
    if (!payload || !Array.isArray(payload.messages)) {
      throw new TypeError('TokenMesh.complete(payload) requires payload.messages (array)');
    }

    const attempts = [];
    for (const slot of await this._nextBatch()) {
      // A concurrent request may have benched this key mid-loop — skip it.
      if (this.isBenched(slot.id)) continue;

      const outcome = await this._attempt(slot, payload);
      if (outcome.ok) {
        this._emit({ type: 'success', slotId: slot.id, provider: slot.provider });
        return outcome.value;
      }

      attempts.push(outcome.error);
      if (outcome.benchMs) this.bench(slot.id, outcome.benchMs);
      this._emit({ type: 'failover', slotId: slot.id, reason: outcome.error.kind, status: outcome.error.status ?? null });

      // 429 and dead keys were benched — the loop instantly moves to the next
      // shuffled key. The user never sees the rate limit.
    }

    if (attempts.length === 0) {
      // Every slot was benched by concurrent requests before we could try one.
      if (_depth < 3) return this.complete(payload, _depth + 1);
      throw new PoolExhaustedError('TokenMesh: pool raced to empty; retry depth exceeded');
    }

    // Every key we touched was rate-limited: the pool is temporarily
    // saturated, not broken. Wait out the shortest bench and re-route instead
    // of surfacing an error — bounded by the retry depth and the
    // maxPoolWaitMs budget enforced inside _waitForAvailable.
    if (attempts.every((a) => a.kind === 'rate_limit') && _depth < 3) {
      return this.complete(payload, _depth + 1);
    }

    const kinds = attempts.map((a) => `${a.provider}/${a.kind}${a.status ? `:${a.status}` : ''}`).join(', ');
    throw new UpstreamError(`TokenMesh: all ${this.slots.length} provider keys failed (${kinds})`, attempts);
  }

  async _nextBatch() {
    let available = this.availableSlots();
    if (available.length === 0) available = await this._waitForAvailable();
    return orderWaterfall(available, this.random);
  }

  /** All keys benched: block until the shortest bench expires (bounded). */
  async _waitForAvailable() {
    const deadline = Date.now() + this.maxPoolWaitMs;
    for (;;) {
      const available = this.availableSlots();
      if (available.length > 0) return available;

      const earliest = Math.min(...this._benches.values());
      const wait = Math.max(0, earliest - Date.now());
      if (Date.now() + wait > deadline) {
        throw new PoolExhaustedError(
          `TokenMesh: all ${this.slots.length} keys are benched; earliest frees in ${Math.ceil(wait / 1000)}s. ` +
            'Add more keys to the pool to keep the $0.00 mesh always-available.'
        );
      }
      this._emit({ type: 'pool_wait', ms: wait });
      if (wait > 0) await this.sleep(wait);
    }
  }

  async _attempt(slot, payload) {
    const url = `${slot.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = JSON.stringify({ ...payload, model: slot.model });

    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${slot.key}`,
          ...slot.headers,
        },
        body,
      });
    } catch (networkError) {
      // DNS blip, connection reset, timeout — fail over, do not bench.
      return {
        ok: false,
        benchMs: 0,
        error: { slotId: slot.id, provider: slot.provider, kind: 'network', message: truncate(networkError?.message ?? String(networkError)) },
      };
    }

    if (res.ok) {
      const data = await res.json().catch(() => null);
      return {
        ok: true,
        value: {
          text: data?.choices?.[0]?.message?.content ?? '',
          provider: slot.provider,
          model: data?.model ?? slot.model,
          slotId: slot.id,
          usage: data?.usage ?? null,
        },
      };
    }

    const status = res.status;
    const detail = truncate(await res.text().catch(() => ''));
    const base = { slotId: slot.id, provider: slot.provider, status, detail };

    if (status === 429) {
      // THE headline case: bench 60s, retry instantly on the next key.
      return { ok: false, benchMs: this.benchMs, error: { ...base, kind: 'rate_limit' } };
    }
    if (status === 401 || status === 403) {
      // The key itself is bad — longer penalty so it stops eating requests.
      return { ok: false, benchMs: this.invalidKeyBenchMs, error: { ...base, kind: 'invalid_key' } };
    }
    // 5xx (provider outage) and other 4xx (e.g. model not found on this
    // provider): fail over without benching — the key may be perfectly fine.
    return { ok: false, benchMs: 0, error: { ...base, kind: status >= 500 ? 'server' : 'client' } };
  }

  _emit(event) {
    if (typeof this.onEvent !== 'function') return;
    try {
      this.onEvent(event);
    } catch {
      /* observability must never break routing */
    }
  }
}
