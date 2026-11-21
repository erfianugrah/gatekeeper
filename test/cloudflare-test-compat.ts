/**
 * Compatibility shim replacing `import {...} from "cloudflare:test"`.
 *
 * In @cloudflare/vitest-pool-workers >= 0.13:
 *   - "cloudflare:test" SELF  → "cloudflare:workers" exports
 *   - "cloudflare:test" env   → "cloudflare:workers" env
 *   - fetchMock removed       → ./fetch-mock polyfill
 *
 * Import this instead of "cloudflare:test" to get the same API surface.
 */
import { env, exports } from 'cloudflare:workers';

export { env };

/** Compatibility alias for the old `SELF.fetch()` API. */
export const SELF = exports.default;

export { fetchMock } from './fetch-mock';
