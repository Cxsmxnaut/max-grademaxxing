/**
 * httpGuard.js — light abuse protection for the public /api/max endpoint.
 *
 * The engine itself is server-side and key-backed, so the two cheap attack
 * vectors are (a) a drive-by cross-site POST from some other origin that
 * spends our pooled keys, and (b) a single client hammering the endpoint.
 * Neither needs a database to mitigate:
 *
 *   - requireSameOrigin(): rejects cross-site browser POSTs (an Origin header
 *     that doesn't match the request host). Plain non-browser callers (curl,
 *     server SDKs) send no Origin header and are allowed — this is a CSRF
 *     guard, not authentication.
 *   - RateLimiter: best-effort fixed-window counter keyed by client IP. In a
 *     serverless isolate the map is per-instance, so it's a soft ceiling, not
 *     a hard quota — still enough to stop one client from draining the pool.
 */

/** Trimmed client IP from a Node req or a Fetch-API Request. */
export function clientIp(req) {
  const fwd = req.headers?.get?.('x-forwarded-for') ?? req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  const real = req.headers?.get?.('x-real-ip') ?? req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown';
}

/**
 * @param {Request|object} req  Fetch Request or Node IncomingMessage
 * @param {object} [opts]
 * @param {string} [opts.originHeader] raw Origin header (defaults from req)
 * @param {string} [opts.host] expected host (defaults from req Host header)
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function requireSameOrigin(req, opts = {}) {
  const getHeader = (name) => {
    const v = req.headers?.get?.(name) ?? req.headers?.[name];
    return typeof v === 'string' ? v : '';
  };
  const origin = opts.originHeader ?? getHeader('origin');
  const host = opts.host ?? getHeader('host');

  // No Origin header => non-browser caller (curl, server, prefetch). Not a
  // CSRF vector: browsers always attach Origin on cross-site POSTs.
  if (!origin || origin === 'null') return { allowed: true };
  if (!host) return { allowed: true }; // can't judge; fail open to avoid blocking SDKs

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { allowed: false, reason: 'malformed origin' };
  }
  if (originHost === host) return { allowed: true };
  return { allowed: false, reason: `cross-origin request from ${originHost}` };
}

/**
 * Fixed-window rate limiter. `limit` requests per `windowMs`, per key.
 * Best-effort (in-memory, per isolate) — a soft ceiling, not a hard quota.
 */
export class RateLimiter {
  constructor({ limit = 12, windowMs = 60_000, now = Date.now } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) throw new TypeError('RateLimiter: limit must be a positive number');
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this._hits = new Map(); // key -> { count, windowStart }
  }

  /** @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }} */
  check(key) {
    const t = this.now();
    let entry = this._hits.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      entry = { count: 0, windowStart: t };
      this._hits.set(key, entry);
    }
    entry.count += 1;

    // opportunistic cleanup so the map can't grow unbounded
    if (this._hits.size > 10_000) this._prune(t);

    if (entry.count <= this.limit) {
      return { allowed: true, remaining: this.limit - entry.count, retryAfterMs: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, entry.windowStart + this.windowMs - t) };
  }

  _prune(t) {
    for (const [k, e] of this._hits) {
      if (t - e.windowStart >= this.windowMs) this._hits.delete(k);
    }
  }
}
