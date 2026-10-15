/**
 * demo/server.js — minimal static + API server to demo the Max chat UI.
 *
 * Serves public/index.html and proxies POST /api/max to the stateless
 * askMax() engine. This file is demo glue only — the actual product module
 * is src/, which has no server in it at all.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { askMaxDetailed, UpstreamError, PoolExhaustedError } from '../src/index.js';

// load local dev keys if present (process.loadEnvFile: zero-dependency .env)
if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number(process.env.PORT) || 5199; // env PORT=0 means "random", treat as unset
const HTML_PATH = new URL('../public/index.html', import.meta.url);
const MAX_BODY_BYTES = 512 * 1024;

const html = await readFile(HTML_PATH, 'utf8');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
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

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/max') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }

      try {
        const result = await askMaxDetailed(body.studentDataContext ?? null, body.userQuery);
        return sendJson(res, 200, {
          text: result.text,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
        });
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return sendJson(res, 503, { error: err.message, type: err.name, retryable: true });
        }
        if (err instanceof UpstreamError) {
          return sendJson(res, 502, {
            error: 'all pooled provider keys failed',
            type: err.name,
            attempts: err.attempts.map(({ detail, ...a }) => a), // strip upstream bodies
          });
        }
        if (err instanceof TypeError && /No provider keys configured/.test(err.message)) {
          return sendJson(res, 503, { error: err.message, type: 'NotConfigured', retryable: false });
        }
        throw err;
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
