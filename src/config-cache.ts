/**
 * Isolate-level cache for GatewayConfig.
 *
 * The gateway config changes rarely (only via admin PUT/DELETE). Caching it
 * at isolate scope with a short TTL avoids a DO RPC on every purge request.
 * Config mutations call invalidate() so changes take effect immediately.
 */

import type { GatewayConfig } from './config-registry';

// ─── Constants ──────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS = 30_000;

// ─── State ──────────────────────────────────────────────────────────────────

let cached: { config: GatewayConfig; fetchedAt: number } | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

/** Get gateway config, returning a cached copy if within TTL. */
export async function getCachedConfig(stub: { getConfig: () => Promise<GatewayConfig> }): Promise<GatewayConfig> {
	const now = Date.now();
	if (cached && now - cached.fetchedAt < CONFIG_CACHE_TTL_MS) {
		return cached.config;
	}
	const config = await stub.getConfig();
	cached = { config, fetchedAt: now };
	return config;
}

/** Invalidate the cached config. Called after admin config mutations. */
export function invalidateConfigCache(): void {
	cached = null;
}

/**
 * Clear the config cache.
 * @internal Exported for testing only — do not use in production code.
 */
export function __testClearConfigCache(): void {
	cached = null;
}
