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
 *   7. Hung upstreams          -> every fetch carries an abort signal: a
 *      silent provider is cut off (attemptTimeoutMs for non-stream, idle
 *      timeout between SSE chunks), benched like a rate limit, and the
 *      request fails over — no key can stall a reply until the platform
 *      kills the invocation.
 *
 * The mesh is stateless with respect to conversations: it only ever tracks
 * per-key bench timers. No message history is stored, ever.
 */

export const DEFAULT_BENCH_MS = 60_000; // 60 seconds, per spec
export const DEFAULT_BENCH_JITTER_MS = 1_000; // avoids thundering-herd retries
export const INVALID_KEY_BENCH_MS = 10 * 60_000; // 401/403 keys get a longer penalty
export const DEFAULT_MAX_POOL_WAIT_MS = 120_000;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000; // non-stream: headers + body must finish within this
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 20_000; // stream: max silence between SSE reads (first read included)

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
   * @param {number}   [opts.attemptTimeoutMs=20000]   abort a hung non-stream attempt (0 disables)
   * @param {number}   [opts.streamIdleTimeoutMs=20000] abort an SSE stream silent this long (0 disables)
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
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
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
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.streamIdleTimeoutMs = streamIdleTimeoutMs;
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
    return this._route(
      payload,
      (slot) => this._attempt(slot, payload),
      (depth) => this.complete(payload, depth),
      _depth
    );
  }

  /**
   * Streaming variant: same waterfall, benching and failover as complete(),
   * but tokens are handed to onToken as they arrive over SSE.
   *
   * Safe-by-construction ordering: every failure that can fail over (429,
   * dead key, 5xx, network) happens BEFORE the first token is delivered —
   * the provider only starts emitting after we have a 200 with a stream
   * body. Once tokens have been delivered we cannot replay them on another
   * key, so a mid-stream break throws UpstreamError (attempts: kind
   * 'stream') instead of silently stitching a second provider's answer onto
   * a partial one.
   *
   * @param {object} payload OpenAI-style chat payload
   * @param {(chunk: string) => void} onToken called per content delta
   * @returns {Promise<{text: string, provider: string, model: string, slotId: string, usage: object|null}>}
   */
  async completeStream(payload, onToken, _depth = 0) {
    if (!payload || !Array.isArray(payload.messages)) {
      throw new TypeError('TokenMesh.completeStream(payload) requires payload.messages (array)');
    }
    if (typeof onToken !== 'function') {
      throw new TypeError('TokenMesh.completeStream(payload, onToken) requires onToken (function)');
    }
    return this._route(
      payload,
      (slot) => this._attemptStream(slot, payload, onToken),
      (depth) => this.completeStream(payload, onToken, depth),
      _depth
    );
  }

  /**
   * Shared routing loop for complete() and completeStream().
   * rerun(depth) re-enters the owning method with a bumped retry depth.
   */
  async _route(payload, attemptFn, rerun, _depth) {
    const attempts = [];
    for (const slot of await this._nextBatch()) {
      // A concurrent request may have benched this key mid-loop — skip it.
      if (this.isBenched(slot.id)) continue;

      const outcome = await attemptFn(slot);
      if (outcome.ok) {
        this._emit({ type: 'success', slotId: slot.id, provider: slot.provider });
        return outcome.value;
      }

      attempts.push(outcome.error);
      if (outcome.benchMs) this.bench(slot.id, outcome.benchMs);
      this._emit({ type: 'failover', slotId: slot.id, reason: outcome.error.kind, status: outcome.error.status ?? null });

      // Tokens already reached the caller — another key's answer cannot be
      // appended to a partial one, so surface the interruption immediately.
      if (outcome.partial) {
        const kind = outcome.error.kind;
        throw new UpstreamError(`TokenMesh: stream interrupted mid-answer (${kind})`, attempts);
      }

      // 429 and dead keys were benched — the loop instantly moves to the next
      // shuffled key. The user never sees the rate limit.
    }

    if (attempts.length === 0) {
      // Every slot was benched by concurrent requests before we could try one.
      if (_depth < 3) return rerun(_depth + 1);
      throw new PoolExhaustedError('TokenMesh: pool raced to empty; retry depth exceeded');
    }

    // Every key we touched was rate-limited: the pool is temporarily
    // saturated, not broken. Wait out the shortest bench and re-route instead
    // of surfacing an error — bounded by the retry depth and the
    // maxPoolWaitMs budget enforced inside _waitForAvailable.
    if (attempts.every((a) => a.kind === 'rate_limit') && _depth < 3) {
      return rerun(_depth + 1);
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

  /**
   * POST one payload to one slot; no streaming.
   * The whole attempt (response headers + JSON body) must finish within
   * attemptTimeoutMs, otherwise the fetch is aborted, the key is benched
   * (kind 'timeout') and routing moves on.
   */
  async _attempt(slot, payload) {
    const url = this._chatUrl(slot);
    const body = JSON.stringify({ ...payload, model: slot.model });

    const controller = new AbortController();
    const timer = this.attemptTimeoutMs > 0 ? setTimeout(() => controller.abort(), this.attemptTimeoutMs) : null;

    try {
      const res = await this._post(url, slot, body, controller.signal);
      if (!res.ok) return await this._classifyHttp(slot, res);

      const data = await res.json().catch(() => null);
      if (data === null && controller.signal.aborted) {
        return this._timeoutFailure(slot, `response body stalled past ${this.attemptTimeoutMs}ms`);
      }
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
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _timeoutFailure(slot, message) {
    return {
      ok: false,
      benchMs: this.benchMs,
      error: { slotId: slot.id, provider: slot.provider, status: null, kind: 'timeout', message: truncate(message) },
    };
  }

  /**
   * Race a promise (a body read, or the fallback JSON parse) against the
   * stream idle timeout. On expiry the fetch is aborted — releasing the
   * socket — and an error flagged `isIdleTimeout` is thrown so the caller
   * can classify it as a timeout instead of a plain network drop.
   */
  _withIdleTimeout(promise, controller) {
    if (!(this.streamIdleTimeoutMs > 0)) return promise;
    let timer;
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Reject with the flagged error BEFORE aborting: the abort makes the
        // pending read reject too, and that AbortError must not win the race
        // (it would be classified as a plain network drop, without benching).
        const err = new Error(`TokenMesh: stream silent for ${this.streamIdleTimeoutMs}ms`);
        err.isIdleTimeout = true;
        reject(err);
        controller.abort();
      }, this.streamIdleTimeoutMs);
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
  }

  /**
   * POST one payload to one slot with stream:true and pump SSE deltas into
   * onToken. Returns ok:false with partial:true once any token was
   * delivered (the caller must not retry — see completeStream).
   */
  async _attemptStream(slot, payload, onToken) {
    const url = this._chatUrl(slot);
    const body = JSON.stringify({ ...payload, model: slot.model, stream: true });

    // Stage 1: response headers must arrive within attemptTimeoutMs — a
    // provider that never answers is aborted before it can stall the reply.
    const controller = new AbortController();
    const startTimer = this.attemptTimeoutMs > 0 ? setTimeout(() => controller.abort(), this.attemptTimeoutMs) : null;
    const res = await this._post(url, slot, body, controller.signal);
    if (startTimer) clearTimeout(startTimer);
    if (!res.ok) return this._classifyHttp(slot, res);

    // Defensive fallback: a provider that ignores stream:true answers with a
    // normal JSON body — parse it (under the idle timeout) and deliver it as
    // one chunk.
    const reader = typeof res.body?.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) {
      let data = null;
      try {
        data = await this._withIdleTimeout(res.json(), controller);
      } catch (err) {
        if (err?.isIdleTimeout) return this._timeoutFailure(slot, err.message);
      }
      const text = data?.choices?.[0]?.message?.content ?? '';
      if (text) onToken(text);
      return {
        ok: true,
        value: { text, provider: slot.provider, model: data?.model ?? slot.model, slotId: slot.id, usage: data?.usage ?? null },
      };
    }

    const decoder = new TextDecoder();
    let text = '';
    let usage = null;
    let model = slot.model;
    let delivered = false;
    let sawDone = false;
    let buf = '';

    try {
      for (;;) {
        // Idle-bounded: covers both "never starts" and "stalls mid-answer".
        const { done, value } = await this._withIdleTimeout(reader.read(), controller);
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line.startsWith(':')) continue; // comments/keep-alives
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            sawDone = true;
            break;
          }
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue; // malformed frame — skip, don't kill the stream
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.model) model = chunk.model;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta !== '') {
            delivered = true;
            text += delta;
            onToken(delta);
          }
        }
        if (sawDone) break;
      }
    } catch (streamError) {
      // A silent stream before the first token is a timeout: bench the key
      // and fail over. After the first token it stays an interruption
      // (partial) — the caller must not stitch a second provider's answer on.
      const timedOut = streamError?.isIdleTimeout === true && !delivered;
      const error = {
        slotId: slot.id,
        provider: slot.provider,
        kind: delivered ? 'stream' : timedOut ? 'timeout' : 'network',
        message: truncate(streamError?.message ?? String(streamError)),
      };
      // partial:true only when the caller already saw tokens.
      return { ok: false, benchMs: timedOut ? this.benchMs : 0, error, partial: delivered };
    }

    // Whole body buffered but never framed as SSE (some proxies re-wrap the
    // response): try to salvage a plain JSON completion.
    if (!delivered && !sawDone && buf.trim().startsWith('{')) {
      try {
        const data = JSON.parse(buf.trim());
        const text2 = data?.choices?.[0]?.message?.content ?? '';
        if (text2) {
          delivered = true;
          text = text2;
          if (data.usage) usage = data.usage;
          if (data.model) model = data.model;
          onToken(text2);
        }
      } catch {
        /* not salvageable — fall through with empty text */
      }
    }

    return {
      ok: true,
      value: { text, provider: slot.provider, model, slotId: slot.id, usage },
    };
  }

  _chatUrl(slot) {
    return `${slot.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async _post(url, slot, body, signal) {
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${slot.key}`,
          ...slot.headers,
        },
        body,
        signal,
      });
    } catch (networkError) {
      // DNS blip, connection reset — fail over, do not bench. An abort from
      // our own timer is a timeout: bench the silent key so the next request
      // skips it instead of paying the timeout again.
      // Returned as a response-shaped failure so both attempt paths share
      // the classification below.
      return {
        ok: false,
        status: 0,
        _networkError: truncate(networkError?.message ?? String(networkError)),
        ...(signal?.aborted ? { _timeout: true } : {}),
        json: async () => null,
        text: async () => '',
      };
    }
  }

  /** Map an unsuccessful HTTP (or network) result to a bench/failover decision. */
  async _classifyHttp(slot, res) {
    const base = { slotId: slot.id, provider: slot.provider, status: res.status || null };

    if (res._timeout) {
      // Our abort timer fired: the provider produced nothing within the
      // attempt timeout. Bench it (like a rate limit) and fail over.
      return { ok: false, benchMs: this.benchMs, error: { ...base, kind: 'timeout', message: res._networkError } };
    }
    if (res._networkError !== undefined || res.status === 0) {
      return { ok: false, benchMs: 0, error: { ...base, kind: 'network', message: res._networkError } };
    }

    const detail = truncate(await res.text().catch(() => ''));
    base.detail = detail;
    const status = res.status;

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
