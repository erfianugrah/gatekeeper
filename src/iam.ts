import type {
	ApiKey,
	KeyScope,
	CachedKey,
	CreateKeyRequest,
	AuthResult,
	PurgeBody,
	ScopeType,
} from "./types";

/**
 * IAM key management backed by DO SQLite storage.
 */
/** Type-safe helper to avoid repetitive `as unknown as T[]` on every query. */
function queryAll<T>(sql: SqlStorage, query: string, ...params: unknown[]): T[] {
	return sql.exec(query, ...params).toArray() as unknown as T[];
}

export class IamManager {
	private sql: SqlStorage;
	private cache: Map<string, CachedKey> = new Map();
	private cacheTtlMs: number;

	constructor(sql: SqlStorage, cacheTtlMs: number = 60_000) {
		this.sql = sql;
		this.cacheTtlMs = cacheTtlMs;
	}

	/** Create tables if they don't exist. Call inside blockConcurrencyWhile. */
	initTables(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS api_keys (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				zone_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				bulk_rate REAL,
				bulk_bucket REAL,
				single_rate REAL,
				single_bucket REAL
			);
		`);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS key_scopes (
				key_id TEXT NOT NULL REFERENCES api_keys(id),
				scope_type TEXT NOT NULL,
				scope_value TEXT NOT NULL,
				PRIMARY KEY (key_id, scope_type, scope_value)
			);
		`);

		// Migration: add rate limit columns if table already existed without them
		try {
			this.sql.exec("SELECT bulk_rate FROM api_keys LIMIT 0");
		} catch {
			this.sql.exec("ALTER TABLE api_keys ADD COLUMN bulk_rate REAL");
			this.sql.exec("ALTER TABLE api_keys ADD COLUMN bulk_bucket REAL");
			this.sql.exec("ALTER TABLE api_keys ADD COLUMN single_rate REAL");
			this.sql.exec("ALTER TABLE api_keys ADD COLUMN single_bucket REAL");
		}
	}

	/**
	 * Generate a new API key.
	 * All sql.exec calls are synchronous within one DO request handler invocation,
	 * so DO's automatic write coalescing ensures atomicity without explicit transactions.
	 */
	createKey(req: CreateKeyRequest): { key: ApiKey; scopes: KeyScope[] } {
		const id = this.generateKeyId();
		const now = Date.now();
		const expiresAt = req.expires_in_days
			? now + req.expires_in_days * 86400_000
			: null;

		const rl = req.rate_limit;
		this.sql.exec(
			`INSERT INTO api_keys (id, name, zone_id, created_at, expires_at, revoked, bulk_rate, bulk_bucket, single_rate, single_bucket)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
			id,
			req.name,
			req.zone_id,
			now,
			expiresAt,
			rl?.bulk_rate ?? null,
			rl?.bulk_bucket ?? null,
			rl?.single_rate ?? null,
			rl?.single_bucket ?? null,
		);

		const scopes: KeyScope[] = [];
		for (const s of req.scopes) {
			this.sql.exec(
				`INSERT INTO key_scopes (key_id, scope_type, scope_value)
				 VALUES (?, ?, ?)`,
				id,
				s.scope_type,
				s.scope_value,
			);
			scopes.push({ key_id: id, scope_type: s.scope_type as ScopeType, scope_value: s.scope_value });
		}

		const key: ApiKey = {
			id,
			name: req.name,
			zone_id: req.zone_id,
			created_at: now,
			expires_at: expiresAt,
			revoked: 0,
			bulk_rate: rl?.bulk_rate ?? null,
			bulk_bucket: rl?.bulk_bucket ?? null,
			single_rate: rl?.single_rate ?? null,
			single_bucket: rl?.single_bucket ?? null,
		};

		return { key, scopes };
	}

	/** List keys. zoneId filters by zone (required now that all zones share one DO). Optional status filter. */
	listKeys(zoneId?: string, filter?: "active" | "revoked"): ApiKey[] {
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (zoneId) {
			conditions.push("zone_id = ?");
			params.push(zoneId);
		}

		if (filter === "active") {
			conditions.push("revoked = 0");
			conditions.push("(expires_at IS NULL OR expires_at > ?)");
			params.push(Date.now());
		} else if (filter === "revoked") {
			conditions.push("revoked = 1");
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		return queryAll<ApiKey>(this.sql, `SELECT * FROM api_keys${where} ORDER BY created_at DESC`, ...params);
	}

	/** Get a single key with its scopes. */
	getKey(id: string): { key: ApiKey; scopes: KeyScope[] } | null {
		const rows = queryAll<ApiKey>(this.sql, "SELECT * FROM api_keys WHERE id = ?", id);
		if (rows.length === 0) return null;

		const scopes = queryAll<KeyScope>(this.sql, "SELECT * FROM key_scopes WHERE key_id = ?", id);

		return { key: rows[0], scopes };
	}

	/** Soft-revoke a key. */
	revokeKey(id: string): boolean {
		const result = this.sql.exec(
			"UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0",
			id,
		);
		this.cache.delete(id);
		return result.rowsWritten > 0;
	}

	/**
	 * Authenticate and authorize a purge request.
	 * Returns an AuthResult indicating if the request is allowed.
	 */
	authorize(keyId: string, zoneId: string, body: PurgeBody): AuthResult {
		const cached = this.getCachedOrLoad(keyId);
		if (!cached) {
			return { authorized: false, error: "Invalid API key" };
		}

		const { key, scopes } = cached;

		if (key.revoked) {
			return { authorized: false, error: "API key has been revoked" };
		}

		if (key.expires_at && key.expires_at < Date.now()) {
			return { authorized: false, error: "API key has expired" };
		}

		if (key.zone_id !== zoneId) {
			return { authorized: false, error: "API key is not authorized for this zone" };
		}

		// Check if wildcard scope
		if (scopes.some((s) => s.scope_type === "*")) {
			return { authorized: true };
		}

		return this.checkScopes(scopes, body);
	}

	// --- Private helpers ---

	private getCachedOrLoad(keyId: string): CachedKey | null {
		const cached = this.cache.get(keyId);
		if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
			return cached;
		}

		const loaded = this.getKey(keyId);
		if (!loaded) {
			this.cache.delete(keyId);
			return null;
		}

		const entry: CachedKey = {
			key: loaded.key,
			scopes: loaded.scopes,
			cachedAt: Date.now(),
		};
		this.cache.set(keyId, entry);
		return entry;
	}

	private checkScopes(scopes: KeyScope[], body: PurgeBody): AuthResult {
		const denied: string[] = [];

		// purge_everything
		if (body.purge_everything) {
			if (!scopes.some((s) => s.scope_type === "purge_everything")) {
				denied.push("purge_everything");
			}
		}

		// files (single-file purge)
		if (body.files) {
			for (const file of body.files) {
				const url = typeof file === "string" ? file : file.url;
				const hasScope = scopes.some(
					(s) => s.scope_type === "url_prefix" && url.startsWith(s.scope_value),
				);
				if (!hasScope) {
					denied.push(url);
				}
			}
		}

		// hosts
		if (body.hosts) {
			for (const host of body.hosts) {
				const hasScope = scopes.some(
					(s) => s.scope_type === "host" && s.scope_value === host,
				);
				if (!hasScope) {
					denied.push(`host:${host}`);
				}
			}
		}

		// tags
		if (body.tags) {
			for (const tag of body.tags) {
				const hasScope = scopes.some(
					(s) => s.scope_type === "tag" && s.scope_value === tag,
				);
				if (!hasScope) {
					denied.push(`tag:${tag}`);
				}
			}
		}

		// prefixes
		if (body.prefixes) {
			for (const pfx of body.prefixes) {
				const hasScope = scopes.some(
					(s) => s.scope_type === "prefix" && pfx.startsWith(s.scope_value),
				);
				if (!hasScope) {
					denied.push(`prefix:${pfx}`);
				}
			}
		}

		if (denied.length > 0) {
			return {
				authorized: false,
				error: `Key does not have scope for: ${denied.join(", ")}`,
				denied,
			};
		}

		return { authorized: true };
	}

	private generateKeyId(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return `pgw_${hex}`;
	}
}
