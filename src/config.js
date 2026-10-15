/**
 * config.js — builds the pooled key array for the Token Mesh.
 *
 * Keys come only from the server environment (or an explicit call to
 * createPool). They are never sent to the browser and never written to disk
 * by this module.
 */
import { TokenMesh } from './tokenMesh.js';

/**
 * Free-tier defaults (verified October 2026):
 *   - Groq hosts no Llama/Gemma chat models anymore (they were all retired
 *     for the developer tier); qwen3.8-27b is its best free chat model and
 *     writes far more naturally than gpt-oss-20b.
 *   - OpenRouter free catalog rotates often; nemotron-3.5-lightning:free was
 *     the verified live zero-cost endpoint.
 *   - Mistral: mistral-small-latest is the documented stable alias.
 *   - Gemini: gemini-3.8-flash is the newest flash BOTH of our Gemini keys
 *     can serve (newer accounts no longer see gemini-2.5-flash), and it is
 *     the tone/quality baseline for Max.
 */
export const PROVIDER_DEFAULTS = {
  // Tier 1 = primary waterfall layer: tried before any Tier-2 slot.
  gemini: {
    // Google AI Studio keys speak OpenAI-compatible protocol here; free tier.
    // (gemini-flash-latest 503s under load; 2.5-flash is the stable workhorse.)
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    tier: 1,
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    tier: 2,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3.5-lightning:free',
    tier: 2,
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    tier: 2,
  },
};

function openRouterHeaders(env) {
  const headers = {};
  if (env.APP_URL) headers['HTTP-Referer'] = env.APP_URL; // optional attribution
  if (env.APP_NAME) headers['X-OpenRouter-Title'] = env.APP_NAME;
  return headers;
}

/**
 * Turn a keyed object of provider -> key array into flat mesh slots.
 *
 * @param {Record<string, string[]>} keysByProvider
 *   e.g. { groq: ['gk_...','gk_...'], openrouter: ['sk-or-...'], mistral: ['...'] }
 * @param {object} [overrides]
 *   { models?: Record<string,string>, baseUrls?: Record<string,string>, env?: object }
 */
export function createPool(keysByProvider, overrides = {}) {
  const slots = [];
  // guard against the exact bug this once had: a duplicate provider key in
  // PROVIDER_DEFAULTS silently drops fields (object literals keep the last)
  const providers = Object.keys(PROVIDER_DEFAULTS);
  if (new Set(providers).size !== providers.length) {
    throw new Error(`PROVIDER_DEFAULTS has duplicate provider keys: ${providers.join(', ')}`);
  }
  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    const keys = (keysByProvider?.[provider] ?? []).filter(Boolean);
    const model = overrides.models?.[provider] ?? defaults.model;
    const baseUrl = overrides.baseUrls?.[provider] ?? defaults.baseUrl;
    const headers = overrides.headers?.[provider] ?? (provider === 'openrouter' ? openRouterHeaders(overrides.env ?? {}) : {});
    const tier = overrides.tiers?.[provider] ?? defaults.tier ?? 2;

    keys.forEach((key, i) => {
      slots.push({ id: `${provider}-${i + 1}`, provider, key, model, baseUrl, headers, tier });
    });
  }
  return slots;
}

const splitKeys = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Pool from environment variables (comma-separated key lists):
 *   GROQ_API_KEYS, OPENROUTER_API_KEYS, MISTRAL_API_KEYS, GEMINI_API_KEYS
 * Optional overrides:
 *   GROQ_MODEL / OPENROUTER_MODEL / MISTRAL_MODEL / GEMINI_MODEL
 *   <PROVIDER>_BASE_URL for any of the above
 *   APP_URL, APP_NAME (OpenRouter attribution headers)
 */
export function createPoolFromEnv(env = process.env) {
  return createPool(
    {
      groq: splitKeys(env.GROQ_API_KEYS),
      openrouter: splitKeys(env.OPENROUTER_API_KEYS),
      mistral: splitKeys(env.MISTRAL_API_KEYS),
      gemini: splitKeys(env.GEMINI_API_KEYS),
    },
    {
      env,
      models: { groq: env.GROQ_MODEL, openrouter: env.OPENROUTER_MODEL, mistral: env.MISTRAL_MODEL, gemini: env.GEMINI_MODEL },
      baseUrls: { groq: env.GROQ_BASE_URL, openrouter: env.OPENROUTER_BASE_URL, mistral: env.MISTRAL_BASE_URL, gemini: env.GEMINI_BASE_URL },
    }
  );
}

/** Convenience factory: mesh wired straight from the environment. */
export function createMeshFromEnv(env = process.env, meshOptions = {}) {
  const slots = createPoolFromEnv(env);
  if (slots.length === 0) {
    throw new Error(
      'No provider keys configured. Set GROQ_API_KEYS / OPENROUTER_API_KEYS / MISTRAL_API_KEYS ' +
        '(comma-separated lists) in the server environment.'
    );
  }
  return new TokenMesh({ slots, ...meshOptions });
}
