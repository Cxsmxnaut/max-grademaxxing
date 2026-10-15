# grademaxxing-max-engine

Stateless AI routing + persona backend for Grademaxxing, with an
Open WebUI-styled chat component. **$0.00 operating cost** — every request is
routed across a pooled array of free-tier provider keys (Groq, OpenRouter,
Mistral, Google AI Studio).

```
src/
  tokenMesh.js   # THE MODEL SWITCHER ENGINE — shuffle, 429 bench, instant failover
  config.js      # provider pool construction (env or explicit key arrays)
  max.js         # MAX'S CORE ENGINE — persona, temp 0.3, askMax()
  index.js       # public exports
frontend/
  MaxChatWindow.jsx  # React + Tailwind chat window (Open WebUI-styled)
public/
  index.html     # zero-dependency vanilla chat window (same design)
demo/
  server.js      # demo glue: static + POST /api/max (not part of the module)
test/            # node:test suite with mocked fetch
```

## 1. The Token Mesh (model switcher)

- Pooled key array across **Groq + OpenRouter + Mistral + Gemini** (any
  OpenAI-compatible provider works — add one to `PROVIDER_DEFAULTS`).
- **Waterfall tiers with within-tier shuffle:** Tier-1 keys (Gemini) are
  tried first and split traffic evenly between them; only when every Tier-1
  key fails or is benched does the request fall through to Tier-2
  (OpenRouter/Groq). Both tiers Fisher-Yates shuffle per request.
- **HTTP 429 → the key is benched for 60 s** (+1 s jitter to avoid
  thundering herds) and the **exact same request is instantly retried on the
  next shuffled key**. The caller never sees the rate limit.
- 401/403 (dead key) → 10-minute bench + failover. 5xx / network drop →
  failover without benching. If the whole pool is saturated, the mesh waits
  out the shortest bench (bounded) instead of erroring.
- Observability: pass `onEvent` to receive `bench` / `failover` / `success`
  / `pool_wait` events.

```js
import { TokenMesh, createPool } from 'grademaxxing-max-engine';

const mesh = new TokenMesh({
  slots: createPool({ groq: ['gk_..','gk_..'], openrouter: ['sk-or-..'], mistral: ['..'] }),
  onEvent: (e) => console.log(e.type, e.slotId ?? ''),
});

const res = await mesh.complete({ temperature: 0.3, messages: [...] });
// -> { text, provider, model, slotId, usage }
```

## 2. Max's core engine (persona)

- `temperature` is **locked to 0.3** on every payload (math precision).
- **Fully stateless** — no DB, no history. Each request packages:
  1. the Max system prompt (warm, natural tutor voice),
  2. a separate system message with the active screen's grade/trend data
     as JSON,
  3. the user's question.
- Keys come from the environment only (see `.env.example`):

```js
import { askMax } from 'grademaxxing-max-engine';

const answer = await askMax(
  { screen: 'course-overview', course: 'AP Chemistry', currentAverage: 88.4, trend: [...] },
  'what happens to my average if I bomb the final?'
);
// -> Max's reply text. 429s were handled inside the mesh; you just get the answer.
```

`askMaxDetailed()` returns the same result with `provider/model/usage`
metadata for analytics.

## Frontend

- `public/index.html` — self-contained vanilla component (open it or run the
  demo). Dark #171717 canvas, #303030 user pills, borderless rounded-24px
  composer with a circular send button — the Open WebUI look, Max typography.
- `frontend/MaxChatWindow.jsx` — same design as a React + Tailwind
  component. Pure UI: `messages`, `onSend`, `busy` props; no network logic.

Run the interactive demo (UI-only replies until keys are configured):

```
npm run demo        # http://127.0.0.1:5199/?demo=1
```

Without keys, `POST /api/max` returns a clear 503 explaining which env vars
to set — the UI renders it as a system line instead of failing silently.

## Tests

```
npm test    # node:test, mocked fetch — 23 assertions incl.:
            # 429 bench + instant failover, shuffle distribution,
            # dead-key penalty, saturation wait, exact prompt injection,
            # temperature lock, stateless packaging
```

## Security notes

- Provider keys live **only** in server env vars — never in the client, the
  repo, or the UI. `.env` is gitignored.
- The demo server strips upstream error bodies before returning them, so
  provider responses never leak through the API.
- The chat UI renders with `textContent` (no `innerHTML` of model output),
  so no markdown/XSS surface.
- Swap `demo/server.js` for your real server; `src/` has zero server
  assumptions and zero runtime dependencies (Node ≥ 18, native fetch).
