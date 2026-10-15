#!/usr/bin/env node
/**
 * scripts/check-keys.js — probe every pooled provider key and report health.
 *
 *   npm run keys            (or: node scripts/check-keys.js)
 *
 * Sends a 1-token chat completion to each slot using the same payload shape
 * the mesh uses, then reports OK / rate-limited / dead key / outage with
 * latency. Exit code 0 when at least one key works, 1 when the pool is
 * unusable — safe to wire into cron or CI for rotation alarms.
 *
 * Reads the same env vars as the engine (GROQ_API_KEYS, OPENROUTER_API_KEYS,
 * MISTRAL_API_KEYS, GEMINI_API_KEYS + model overrides); loads .env locally.
 * Keys are only printed as slot ids (groq-1, gemini-2…) — never as values.
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { createPoolFromEnv } = await import('../src/config.js');

const TIMEOUT_MS = Number(process.env.KEY_CHECK_TIMEOUT_MS) || 15_000;
const slots = createPoolFromEnv(process.env);

if (slots.length === 0) {
  console.error('No keys configured. Set GROQ_API_KEYS / OPENROUTER_API_KEYS / MISTRAL_API_KEYS / GEMINI_API_KEYS.');
  process.exit(1);
}

function classifyStatus(status) {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'DEAD KEY';
  if (status === 404) return 'model not found';
  if (status >= 500) return 'provider outage';
  return `HTTP ${status}`;
}

async function probe(slot) {
  const url = `${slot.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${slot.key}`,
        ...slot.headers,
      },
      body: JSON.stringify({
        model: slot.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return { slot, ok: true, ms, note: `serves ${data?.model ?? slot.model}` };
    }
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
    return { slot, ok: false, ms, note: classifyStatus(res.status), detail };
  } catch (err) {
    const ms = Date.now() - started;
    const note = err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : `network: ${err?.message ?? err}`;
    return { slot, ok: false, ms, note, detail: '' };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`Probing ${slots.length} key(s) — ${slots.map((s) => s.id).join(', ')}\n`);
const results = await Promise.all(slots.map(probe));

const idW = Math.max(...results.map((r) => r.slot.id.length), 2);
const provW = Math.max(...results.map((r) => r.slot.provider.length), 8);

for (const r of results.sort((a, b) => a.slot.id.localeCompare(b.slot.id))) {
  const status = r.ok ? 'OK  ' : 'FAIL';
  const line = `${status}  ${r.slot.id.padEnd(idW)}  ${r.slot.provider.padEnd(provW)}  ${String(r.ms).padStart(5)}ms  ${r.note}`;
  console.log(line);
  if (!r.ok && r.detail) console.log(`      ${r.detail}`);
}

const okCount = results.filter((r) => r.ok).length;
console.log(`\n${okCount}/${results.length} keys healthy`);

// A partially-limited pool is still fine (that's what benches are for) —
// only a fully dead pool should alarm.
if (okCount === 0) {
  console.error('Pool unusable: every key failed.');
  process.exit(1);
}
if (okCount < results.length) {
  console.log('Some keys failed — the mesh will bench them; rotate when convenient.');
}
