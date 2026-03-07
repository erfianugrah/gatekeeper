import type { RateLimitConfig } from './types';

// ─── Config keys and defaults ───────────────────────────────────────────────

/** All known config keys with their hardcoded defaults. */
export const CONFIG_DEFAULTS: Record<string, number> = {
	bulk_rate: 50,
	bulk_bucket_size: 500,
	bulk_max_ops: 100,
	single_rate: 3000,
	single_bucket_size: 6000,
	single_max_ops: 500,
	key_cache_ttl_ms: 60_000,
	retention_days: 30,
	s3_rps: 100,
	s3_burst: 200,
};

/** The full resolved config object. */
export interface GatewayConfig {
	bulk_rate: number;
	bulk_bucket_size: number;
	bulk_max_ops: number;
	single_rate: number;
	single_bucket_size: number;
	single_max_ops: number;
	key_cache_ttl_ms: number;
	retention_days: number;
	/** S3 proxy: account-level requests per second. */
	s3_rps: number;
	/** S3 proxy: account-level burst capacity. */
	s3_burst: number;
}

/** A single override entry from the registry (for admin display). */
export interface ConfigOverride {
	key: string;
	value: string;
	updated_at: number;
	updated_by: string | null;
}

/** Map env var names to config key names. */
const ENV_TO_CONFIG: Record<string, string> = {
	BULK_RATE: 'bulk_rate',
	BULK_BUCKET_SIZE: 'bulk_bucket_size',
	BULK_MAX_OPS: 'bulk_max_ops',
	SINGLE_RATE: 'single_rate',
	SINGLE_BUCKET_SIZE: 'single_bucket_size',
	SINGLE_MAX_OPS: 'single_max_ops',
	KEY_CACHE_TTL_MS: 'key_cache_ttl_ms',
	RETENTION_DAYS: 'retention_days',
	S3_RPS: 's3_rps',
	S3_BURST: 's3_burst',
};

// ─── ConfigManager ──────────────────────────────────────────────────────────

export class ConfigManager {
	private sql: SqlStorage;
	private cache: Map<string, number> | null = null;

	constructor(sql: SqlStorage) {
		this.sql = sql;
	}

	/** Create the config table if it doesn't exist. */
	initTable(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
				updated_by TEXT
			)
		`);
	}

	/** Get the full resolved config: registry > env > hardcoded default. */
	getConfig(env: Env): GatewayConfig {
		const registry = this.loadRegistry();
		const result: Record<string, number> = {};
		const envRecord = env as unknown as Record<string, unknown>;

		for (const [key, hardDefault] of Object.entries(CONFIG_DEFAULTS)) {
			// 1. Registry value (highest priority)
			if (registry.has(key)) {
				result[key] = registry.get(key)!;
				continue;
			}

			// 2. Env var fallback
			const envKey = Object.entries(ENV_TO_CONFIG).find(([, v]) => v === key)?.[0];
			if (envKey) {
				const envVal = envRecord[envKey];
				if (envVal != null) {
					const parsed = Number(envVal);
					if (!isNaN(parsed) && parsed > 0) {
						result[key] = parsed;
						continue;
					}
				}
			}

			// 3. Hardcoded default
			result[key] = hardDefault;
		}

		return result as unknown as GatewayConfig;
	}

	/** Get a single config value with the same resolution order. */
	getValue(key: string, env: Env): number {
		const config = this.getConfig(env);
		return (config as unknown as Record<string, number>)[key] ?? CONFIG_DEFAULTS[key] ?? 0;
	}

	/** Set one or more config values. Invalidates cache. */
	setConfig(updates: Record<string, number>, updatedBy?: string): void {
		for (const [key, value] of Object.entries(updates)) {
			if (!(key in CONFIG_DEFAULTS)) {
				throw new Error(`Unknown config key: ${key}`);
			}
			if (typeof value !== 'number' || value <= 0 || !isFinite(value)) {
				throw new Error(`Config value for ${key} must be a positive finite number`);
			}
			this.sql.exec(
				`INSERT INTO config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
				key,
				String(value),
				Date.now(),
				updatedBy ?? null,
			);
		}
		this.cache = null;
	}

	/** Delete a config key, reverting it to env/default. Invalidates cache. */
	resetKey(key: string): boolean {
		if (!(key in CONFIG_DEFAULTS)) {
			throw new Error(`Unknown config key: ${key}`);
		}
		const cursor = this.sql.exec('DELETE FROM config WHERE key = ?', key);
		this.cache = null;
		return cursor.rowsWritten > 0;
	}

	/** Get raw registry entries (for admin display). */
	listOverrides(): ConfigOverride[] {
		const rows = this.sql.exec('SELECT key, value, updated_at, updated_by FROM config ORDER BY key').toArray();
		return rows.map((r: Record<string, unknown>) => ({
			key: r.key as string,
			value: r.value as string,
			updated_at: r.updated_at as number,
			updated_by: (r.updated_by as string) ?? null,
		}));
	}

	/** Invalidate the in-memory cache. Called after writes. */
	invalidateCache(): void {
		this.cache = null;
	}

	/** Convert the resolved config to a RateLimitConfig (used by token buckets). */
	static toRateLimitConfig(config: GatewayConfig): RateLimitConfig {
		return {
			bulk: {
				rate: config.bulk_rate,
				bucketSize: config.bulk_bucket_size,
				maxOps: config.bulk_max_ops,
			},
			single: {
				rate: config.single_rate,
				bucketSize: config.single_bucket_size,
				maxOps: config.single_max_ops,
			},
		};
	}

	// ─── Private ────────────────────────────────────────────────────────

	private loadRegistry(): Map<string, number> {
		if (this.cache) return this.cache;

		const map = new Map<string, number>();
		const rows = this.sql.exec('SELECT key, value FROM config').toArray();
		for (const row of rows) {
			const val = Number(row.value);
			if (!isNaN(val) && val > 0) {
				map.set(row.key as string, val);
			}
		}
		this.cache = map;
		return map;
	}
}
