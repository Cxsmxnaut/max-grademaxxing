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
import { askMaxDetailed, UpstreamError, PoolExhaustedError } from '../src/index.js';

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
    if (err instanceof PoolExhaustedError) {
      return res.status(503).json({ error: err.message, type: err.name, retryable: true });
    }
    if (err instanceof UpstreamError) {
      return res.status(502).json({
        error: 'all pooled provider keys failed',
        type: err.name,
        attempts: err.attempts.map(({ detail, ...a }) => a), // strip upstream bodies
      });
    }
    if (err instanceof TypeError) {
      // covers "No provider keys configured" and bad input (empty query)
      return res.status(/No provider keys/.test(err.message) ? 503 : 400).json({
        error: err.message,
        type: err.name,
      });
    }
    console.error('askMax failed:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
