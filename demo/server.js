/**
 * demo/server.js — minimal static + API server to demo the Max chat UI.
 *
 * Serves public/ (re-read per request so edits show up without a restart)
 * and proxies POST /api/max to the stateless askMax() engine, with:
 *   - conversation history pass-through (client owns history; nothing stored)
 *   - SSE streaming when the body says { stream: true }
 *   - same-origin check + per-IP rate limit (src/httpGuard.js)
 *
 * This file is demo glue only — the actual product module is src/, which
 * has no server in it at all.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { askMaxDetailed, generateChatTitle } from '../src/index.js';
import { requireSameOrigin, RateLimiter, clientIp } from '../src/httpGuard.js';

// load local dev keys if present (process.loadEnvFile: zero-dependency .env)
if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number(process.env.PORT) || 5199; // env PORT=0 means "random", treat as unset
const HTML_PATH = new URL('../public/index.html', import.meta.url);
const PUBLIC_DIR = new URL('../public/', import.meta.url);
const MAX_BODY_BYTES = 512 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024;

// #3 — soft ceiling per IP; enough to stop one client draining the pool.
const limiter = new RateLimiter({ limit: 12, windowMs: 60_000 });

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// #5 — the HTML is re-read on every request so a local edit is visible on
// refresh (the original cached it once at startup, which made verification
// confusing). A successful read is cached as the fallback if a later one
// fails mid-flight (e.g. editor truncate race).
let htmlCache = '';
async function loadHtml() {
  try {
    htmlCache = await readFile(HTML_PATH, 'utf8');
    return htmlCache;
  } catch (err) {
    if (htmlCache) return htmlCache;
    throw err;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Shared failure classification — matches api/max.js exactly. */
function classifyError(err) {
  // Classify by message/name first — not just instanceof: "No provider
  // keys" is a plain Error, and bundlers can duplicate error classes so
  // instanceof fails while .name survives.
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

/**
 * POST /api/max with { stream: true } → SSE:
 *   data: {"t":"token"}   per content delta
 *   data: {"done":true,"text":...,"provider":...,"model":...,"usage":...}
 *   data: {"error":...,"type":...,"status":...,"partial":bool}  on failure
 * The head is committed before the first token (SSE requires it), so a
 * pre-token failure is reported as an in-stream error event; the UI treats
 * it exactly like a failed request.
 */
function streamMax(res, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // proxies: don't buffer, the whole point is liveness
  });
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client went away — the mesh promise settles regardless */
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
      if (payload.attempts) delete payload.attempts; // too heavy for the stream
      send({ error: payload.error, type: payload.type ?? 'Error', status, partial: delivered });
      res.end();
    });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      const path = req.url.split('?')[0];

      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(await loadHtml());
        return;
      }

      // top-level public/ assets only (markdown.js, css…) — the regex
      // excludes separators, so path traversal is impossible
      if (/^\/[A-Za-z0-9._-]+\.(?:js|css|html|svg)$/.test(path)) {
        try {
          const data = await readFile(new URL(path.slice(1), PUBLIC_DIR));
          res.writeHead(200, {
            'content-type': MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream',
            'cache-control': 'no-store',
          });
          res.end(data);
        } catch {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
        return;
      }
    }

    if (req.method === 'POST' && req.url === '/api/max') {
      // #3 — reject cross-site browser POSTs; curl/SDKs (no Origin) pass.
      const origin = requireSameOrigin(req);
      if (!origin.allowed) {
        return sendJson(res, 403, { error: 'forbidden', reason: origin.reason });
      }
      const verdict = limiter.check(String(clientIp(req)));
      if (!verdict.allowed) {
        return sendJson(
          res,
          429,
          { error: 'too many requests — slow down', retryAfterMs: verdict.retryAfterMs },
          { 'retry-after': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) }
        );
      }

      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      if (body.history != null && Buffer.byteLength(raw) > MAX_HISTORY_BYTES) {
        return sendJson(res, 413, { error: 'history too large' });
      }

      if (body.action === 'title') {
        try {
          const result = await generateChatTitle(body.userQuery, body.assistantReply ?? '', {
            course: body.studentDataContext?.course ?? body.course ?? '',
          });
          return sendJson(res, 200, result);
        } catch (err) {
          const { status, payload } = classifyError(err);
          return sendJson(res, status, payload);
        }
      }

      if (body.stream === true) {
        streamMax(res, body); // async; errors surface inside the stream
        return;
      }

      try {
        const result = await askMaxDetailed(body.studentDataContext ?? null, body.userQuery, {
          history: body.history,
        });
        return sendJson(res, 200, {
          text: result.text,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
        });
      } catch (err) {
        const { status, payload } = classifyError(err);
        if (status === 500) console.error('askMax failed:', err);
        return sendJson(res, status, payload);
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    const status = err?.status ?? 500;
    sendJson(res, status, { error: err?.message ?? 'internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`max demo → http://127.0.0.1:${port}`);
});
