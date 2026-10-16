/**
 * api/max.js — Vercel Serverless Function.
 *
 * Same contract as the local demo server: POST /api/max
 *   { studentDataContext, userQuery, history?, stream? }
 *     -> JSON: { text, provider, model, usage }
 *     -> SSE (stream: true): data:{"t":chunk} … data:{"done":true,…}
 *
 * Provider keys come from Vercel Environment Variables (Project → Settings →
 * Environment Variables): GROQ_API_KEYS, OPENROUTER_API_KEYS, GEMINI_API_KEYS,
 * plus the optional model overrides. Nothing secret lives in this repo.
 *
 * The Token Mesh module-scope cache means warm invocations keep their 429
 * benches; cold starts simply begin with a clean pool. Either way the caller
 * only ever sees a successful reply or a clean JSON error.
 *
 * Abuse protection (src/httpGuard.js): cross-site browser POSTs are
 * rejected (403), and each client IP gets a soft per-isolate rate ceiling
 * (429). Non-browser callers send no Origin header and pass the CSRF check.
 */
import { askMaxDetailed, generateChatTitle } from '../src/index.js';
import { requireSameOrigin, RateLimiter, clientIp } from '../src/httpGuard.js';

// Vercel Node functions only expose res.write() when streaming is opted in.
export const config = { supportsResponseStreaming: true };

// Per-isolate soft ceiling (module scope survives warm invocations).
const limiter = new RateLimiter({ limit: 12, windowMs: 60_000 });

/** Shared failure classification — matches demo/server.js exactly. */
function classifyError(err) {
  const name = err?.name ?? 'Error';
  const message = typeof err?.message === 'string' ? err.message : '';
  const attempts = Array.isArray(err?.attempts) ? err.attempts.map(({ detail, ...a }) => a) : [];

  if (message.includes('No provider keys configured')) {
    return { status: 503, payload: { error: message, type: 'NotConfigured', retryable: false } };
  }
  if (name === 'PoolExhaustedError') {
    return { status: 503, payload: { error: message, type: name, retryable: true } };
  }
  if (name === 'UpstreamError') {
    return { status: 502, payload: { error: message || 'all pooled provider keys failed', type: name, attempts } };
  }
  if (err instanceof TypeError) {
    return { status: 400, payload: { error: message, type: name } };
  }
  return { status: 500, payload: { error: 'internal error', type: name } };
}

/** SSE variant — same frame format as the demo server. */
function streamMax(res, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client disconnected */
    }
  };

  let delivered = false;
  return askMaxDetailed(body.studentDataContext ?? null, body.userQuery, {
    history: body.history,
    onToken: (chunk) => {
      delivered = true;
      send({ t: chunk });
    },
  })
    .then((result) => {
      send({ done: true, text: result.text, provider: result.provider, model: result.model, usage: result.usage });
      res.end();
    })
    .catch((err) => {
      const { status, payload } = classifyError(err);
      if (payload.attempts) delete payload.attempts;
      send({ error: payload.error, type: payload.type ?? 'Error', status, partial: delivered });
      res.end();
    });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const origin = requireSameOrigin(req);
  if (!origin.allowed) {
    return res.status(403).json({ error: 'forbidden', reason: origin.reason });
  }
  const verdict = limiter.check(String(clientIp(req)));
  if (!verdict.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
    return res.status(429).json({ error: 'too many requests — slow down', retryAfterMs: verdict.retryAfterMs });
  }

  // Vercel parses JSON bodies for us, but tolerate a raw string too.
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
  }
  body ??= {};

  if (body.action === 'title') {
    try {
      const result = await generateChatTitle(body.userQuery, body.assistantReply ?? '', {
        course: body.studentDataContext?.course ?? body.course ?? '',
      });
      return res.status(200).json(result);
    } catch (err) {
      const { status, payload } = classifyError(err);
      return res.status(status).json(payload);
    }
  }

  if (body.stream === true) {
    streamMax(res, body);
    return;
  }

  try {
    const result = await askMaxDetailed(body.studentDataContext ?? null, body.userQuery, {
      history: body.history,
    });
    return res.status(200).json({
      text: result.text,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    });
  } catch (err) {
    const { status, payload } = classifyError(err);
    if (status === 500) console.error('askMax failed:', err);
    return res.status(status).json(payload);
  }
}
