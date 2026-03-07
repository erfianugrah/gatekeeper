import { queryAll } from './sql';
import type { BulkResult, BulkItemResult, BulkDryRunResult, BulkInspectItem } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UpstreamToken {
	id: string;
	name: string;
	/** Comma-separated zone IDs, or "*" for all zones. */
	zone_ids: string;
	/** First 4 + last 4 chars of the token for display. */
	token_preview: string;
	created_at: number;
	created_by: string | null;
}

/** Full token row including the secret — never expose via API. */
interface UpstreamTokenRow extends UpstreamToken {
	token: string;
}

export interface CreateUpstreamTokenRequest {
	name: string;
	token: string;
	/** Zone IDs this token can purge, or ["*"] for all. */
	zone_ids: string[];
	created_by?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ID_PREFIX = 'upt_';

// ─── Manager ────────────────────────────────────────────────────────────────

export class UpstreamTokenManager {
	private sql: SqlStorage;
	/** zone_id -> token value cache. Invalidated on write. */
	private resolveCache = new Map<string, { token: string; cachedAt: number }>();
	private cacheTtlMs: number;

	constructor(sql: SqlStorage, cacheTtlMs: number = 60_000) {
		this.sql = sql;
		this.cacheTtlMs = cacheTtlMs;
	}

	/** Create tables if they don't exist. Call inside blockConcurrencyWhile. */
	initTables(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS upstream_tokens (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				token TEXT NOT NULL,
				token_preview TEXT NOT NULL,
				zone_ids TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				created_by TEXT
			);
		`);

		// Migration: remove vestigial "revoked" column from old schema.
		const cols = queryAll<{ name: string }>(this.sql, `PRAGMA table_info('upstream_tokens')`);
		if (cols.some((c) => c.name === 'revoked')) {
			console.log(JSON.stringify({ migration: 'upstream_tokens', action: 'drop_column_revoked', ts: new Date().toISOString() }));
			this.sql.exec(`ALTER TABLE upstream_tokens DROP COLUMN revoked`);
		}
	}

	// ─── CRUD ───────────────────────────────────────────────────────────

	/** Register a new upstream Cloudflare API token. */
	createToken(req: CreateUpstreamTokenRequest): { token: UpstreamToken } {
		const id = this.generateId();
		const now = Date.now();
		const zoneIdsStr = req.zone_ids.join(',');
		const preview = makePreview(req.token);

		this.sql.exec(
			`INSERT INTO upstream_tokens (id, name, token, token_preview, zone_ids, created_at, created_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id,
			req.name,
			req.token,
			preview,
			zoneIdsStr,
			now,
			req.created_by ?? null,
		);

		this.invalidateCache();

		return {
			token: {
				id,
				name: req.name,
				zone_ids: zoneIdsStr,
				token_preview: preview,
				created_at: now,
				created_by: req.created_by ?? null,
			},
		};
	}

	/** List all upstream tokens (never includes the secret). */
	listTokens(): UpstreamToken[] {
		return queryAll<UpstreamToken>(
			this.sql,
			'SELECT id, name, zone_ids, token_preview, created_at, created_by FROM upstream_tokens ORDER BY created_at DESC',
		);
	}

	/** Get a single upstream token by ID (never includes the secret). */
	getToken(id: string): { token: UpstreamToken } | null {
		const rows = queryAll<UpstreamToken>(
			this.sql,
			'SELECT id, name, zone_ids, token_preview, created_at, created_by FROM upstream_tokens WHERE id = ?',
			id,
		);
		if (rows.length === 0) return null;
		return { token: rows[0] };
	}

	/** Permanently delete an upstream token. Returns true if the row existed and was removed. */
	deleteToken(id: string): boolean {
		const result = this.sql.exec('DELETE FROM upstream_tokens WHERE id = ?', id);
		if (result.rowsWritten > 0) {
			this.invalidateCache();
		}
		return result.rowsWritten > 0;
	}

	// ─── Bulk operations ────────────────────────────────────────────────

	/** Bulk hard-delete tokens. Returns per-item status. */
	bulkDelete(ids: string[]): BulkResult {
		const results: BulkItemResult[] = [];
		for (const id of ids) {
			const deleted = this.deleteToken(id);
			results.push({ id, status: deleted ? 'deleted' : 'not_found' });
		}
		return { processed: results.length, results };
	}

	/** Inspect tokens without modifying — for dry-run preview. */
	bulkInspect(ids: string[], wouldBecome: string): BulkDryRunResult {
		const items: BulkInspectItem[] = [];
		for (const id of ids) {
			const existing = this.getToken(id);
			if (!existing) {
				items.push({ id, current_status: 'not_found', would_become: 'not_found' });
			} else {
				items.push({ id, current_status: 'active', would_become: wouldBecome });
			}
		}
		return { dry_run: true, would_process: items.length, items };
	}

	// ─── Resolution ─────────────────────────────────────────────────────

	/**
	 * Resolve the upstream CF API token for a given zone ID.
	 * Returns the token string if a matching active upstream token is found, null otherwise.
	 * Checks zone-specific tokens first, then wildcard tokens.
	 *
	 * NOTE: A wildcard token (`zone_ids: "*"`) catches all zones that don't have an explicit
	 * token. If the wildcard token's CF account doesn't own the zone, the upstream request
	 * will fail with a 403 from the CF API. Only use wildcard tokens when the account owns
	 * all zones served by this gateway.
	 */
	resolveTokenForZone(zoneId: string): string | null {
		// Check cache first
		const cached = this.resolveCache.get(zoneId);
		if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
			return cached.token;
		}

		// Look for a token that covers this zone — prefer exact match over wildcard
		const rows = queryAll<UpstreamTokenRow>(this.sql, 'SELECT * FROM upstream_tokens');

		let wildcardToken: string | null = null;

		for (const row of rows) {
			const zones = row.zone_ids.split(',');
			if (zones.includes(zoneId)) {
				this.resolveCache.set(zoneId, { token: row.token, cachedAt: Date.now() });
				return row.token;
			}
			if (zones.includes('*') && !wildcardToken) {
				wildcardToken = row.token;
			}
		}

		if (wildcardToken) {
			this.resolveCache.set(zoneId, { token: wildcardToken, cachedAt: Date.now() });
			return wildcardToken;
		}

		return null;
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private invalidateCache(): void {
		this.resolveCache.clear();
	}

	private generateId(): string {
		const bytes = new Uint8Array(12);
		crypto.getRandomValues(bytes);
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		return `${ID_PREFIX}${hex}`;
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a preview string: first 4 + "..." + last 4 chars. */
function makePreview(token: string): string {
	if (token.length <= 10) return '****';
	return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
