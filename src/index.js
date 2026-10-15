/**
 * grademaxxing-max-engine
 *
 *   import { askMax } from 'grademaxxing-max-engine';
 *   const answer = await askMax(studentDataContext, 'what happens to my avg if I bomb the final?');
 */
export {
  TokenMesh,
  shuffle,
  PoolExhaustedError,
  UpstreamError,
  DEFAULT_BENCH_MS,
  INVALID_KEY_BENCH_MS,
  DEFAULT_MAX_POOL_WAIT_MS,
} from './tokenMesh.js';

export { PROVIDER_DEFAULTS, createPool, createPoolFromEnv, createMeshFromEnv } from './config.js';

export {
  MAX_SYSTEM_PROMPT,
  MAX_TEMPERATURE,
  buildMaxMessages,
  askMax,
  askMaxDetailed,
  getDefaultMesh,
  setDefaultMesh,
} from './max.js';
