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
 *   - Groq: openai/gpt-oss-120b is OpenAI's 120B flagship hosted free on Groq
 *     with 1,000 req/day and 8,000 TPM per key (across 5 keys = 5,000 req/day),
 *     sub-second time-to-first-token, and native ChatGPT formatting & math
 *     accuracy. (By contrast, qwen/qwen3.8-27b on Groq has a 1,000 OTPM cap
 *     that rejects long step-by-step math explanations with HTTP 413/429.)
 *   - Gemini: gemini-3.5-flash is Google AI Studio's fast, high-quota free
 *     workhorse (gemini-3.8-flash has a tiny 20 RPD free-tier cap that
 *     exhausts almost immediately).
 *   - OpenRouter: nvidia/nemotron-3-ultra-550b-a55b:free is the fastest,
 *     highest-capacity free model on OpenRouter (~400ms latency vs 20s+ hangs
 *     on nemotron-3.5-lightning:free).
 *   - Mistral: mistral-small-latest is the documented stable alias.
 */
export const PROVIDER_DEFAULTS = {
  // Tier 1 = primary waterfall layer: tried before any Tier-2 slot.
  gemini: {
    // Google AI Studio keys speak OpenAI-compatible protocol here; free tier.
    // gemini-3.5-flash is the fast, high-quota free workhorse (gemini-3.8-flash
    // has a tiny 20 RPD free-tier cap that exhausts immediately).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash',
    tier: 1,
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    tier: 2,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
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
 * Normalize deprecated or ultra-low-quota model overrides so stale env vars
 * (e.g. GEMINI_MODEL=gemini-3.8-flash with a 20 RPD cap, or
 * GROQ_MODEL=qwen/qwen3.8-27b with a 1,000 OTPM cap) automatically upgrade to
 * the high-quota workhorse models.
 */
const STALE_MODEL_UPGRADES = {
  'gemini-3.8-flash': 'gemini-3.5-flash',
  'gemini-2.5-flash': 'gemini-3.5-flash',
  'qwen/qwen3.8-27b': 'openai/gpt-oss-120b',
  'nvidia/nemotron-3.5-lightning:free': 'nvidia/nemotron-3-ultra-550b-a55b:free',
};

const resolveModel = (override, fallback) => {
  const trimmed = typeof override === 'string' ? override.trim() : '';
  if (!trimmed) return fallback;
  return STALE_MODEL_UPGRADES[trimmed] ?? trimmed;
};

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
      models: {
        groq: resolveModel(env.GROQ_MODEL, PROVIDER_DEFAULTS.groq.model),
        openrouter: resolveModel(env.OPENROUTER_MODEL, PROVIDER_DEFAULTS.openrouter.model),
        mistral: resolveModel(env.MISTRAL_MODEL, PROVIDER_DEFAULTS.mistral.model),
        gemini: resolveModel(env.GEMINI_MODEL, PROVIDER_DEFAULTS.gemini.model),
      },
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
