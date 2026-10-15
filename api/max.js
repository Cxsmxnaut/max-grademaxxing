/**
 * api/max.js — Vercel Serverless Function.
 *
 * Same contract as the local demo server: POST /api/max
 *   { studentDataContext, userQuery } -> { text, provider, model, usage }
 *
 * Provider keys come from Vercel Environment Variables (Project → Settings →
 * Environment Variables): GROQ_API_KEYS, OPENROUTER_API_KEYS, GEMINI_API_KEYS,
 * plus the optional model overrides. Nothing secret lives in this repo.
 *
 * The Token Mesh module-scope cache means warm invocations keep their 429
 * benches; cold starts simply begin with a clean pool. Either way the caller
 * only ever sees a successful reply or a clean JSON error.
 */
import { askMaxDetailed } from '../src/index.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
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

  try {
    const result = await askMaxDetailed(body.studentDataContext ?? null, body.userQuery);
    return res.status(200).json({
      text: result.text,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    });
  } catch (err) {
    // Classify by message/name first — not just instanceof: "No provider
    // keys" is a plain Error, and bundlers can duplicate error classes so
    // instanceof fails while .name survives.
    const name = err?.name ?? 'Error';
    const message = typeof err?.message === 'string' ? err.message : '';
    const attempts = Array.isArray(err?.attempts) ? err.attempts.map(({ detail, ...a }) => a) : [];

    if (message.includes('No provider keys configured')) {
      return res.status(503).json({ error: message, type: 'NotConfigured', retryable: false });
    }
    if (name === 'PoolExhaustedError') {
      return res.status(503).json({ error: message, type: name, retryable: true });
    }
    if (name === 'UpstreamError') {
      return res.status(502).json({ error: message || 'all pooled provider keys failed', type: name, attempts });
    }
    if (err instanceof TypeError) {
      return res.status(400).json({ error: message, type: name });
    }
    console.error('askMax failed:', err);
    return res.status(500).json({ error: 'internal error', type: name });
  }
}
