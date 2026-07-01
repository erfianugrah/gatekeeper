/**
 * Named, revocable admin API tokens for the /admin management plane.
 *
 * These are the self-service alternative to the single shared ADMIN_KEY env secret:
 * an admin can mint role-scoped tokens (admin/operator/viewer) from the dashboard or
 * CLI and revoke them individually, without rotating a shared secret. The ADMIN_KEY
 * env var stays as the bootstrap / break-glass root of trust; these tokens sit on top.
 *
 * Storage: Durable Object SQLite. Unlike gateway keys, upstream tokens, and sessions
 * (which store the secret verbatim because they must be re-read/forwarded), an admin
 * token is only ever verified, never revealed again after creation, so we store just a
 * SHA-256 hash of the token value plus a display preview. The plaintext token is shown
 * exactly once at create time. SHA-256 is deterministic, so the hash doubles as the
 * lookup key.
 *
 * Token shape: `gka_` + 32 random bytes (64 hex). Public row id: `atk_` + 8 bytes.
 */

import { generateHexId, makePreview, sha256Hex } from './crypto';
import { queryAll } from './sql';
import type { AdminRole } from './types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Prefix that marks a value as an admin API token (vs the static ADMIN_KEY secret). */
export const ADMIN_TOKEN_PREFIX = 'gka_';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Public metadata for one admin token. Never includes the token value or its hash. */
export interface AdminTokenRecord {
	id: string;
	name: string;
	token_preview: string;
	role: AdminRole;
	created_by: string | null;
	created_at: number;
	expires_at: number | null;
	last_used_at: number | null;
	revoked: number;
}

/** Minimal identity returned by a successful token verification. */
export interface AdminTokenAuth {
	id: string;
	name: string;
	role: AdminRole;
}

const PUBLIC_COLS = 'id, name, token_preview, role, created_by, created_at, expires_at, last_used_at, revoked';

// ─── Manager ────────────────────────────────────────────────────────────────

export class AdminTokenManager {
	constructor(private sql: SqlStorage) {}

	/** Create the admin_tokens table if it doesn't exist. */
	initTable(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS admin_tokens (
				id            TEXT PRIMARY KEY,
				name          TEXT NOT NULL,
				token_hash    TEXT NOT NULL UNIQUE,
				token_preview TEXT NOT NULL,
				role          TEXT NOT NULL,
				created_by    TEXT,
				created_at    INTEGER NOT NULL,
				expires_at    INTEGER,
				last_used_at  INTEGER,
				revoked       INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.sql.exec('CREATE INDEX IF NOT EXISTS idx_admin_tokens_hash ON admin_tokens (token_hash)');
		this.sql.exec('CREATE INDEX IF NOT EXISTS idx_admin_tokens_expires ON admin_tokens (expires_at)');
	}

	/**
	 * Mint a new admin token. Returns the plaintext token (shown once) plus the stored
	 * record. Only the SHA-256 hash and a preview are persisted.
	 */
	async createToken(input: { name: string; role: AdminRole; createdBy?: string | null; expiresAt?: number | null }): Promise<{
		token: string;
		record: AdminTokenRecord;
	}> {
		const token = generateHexId(ADMIN_TOKEN_PREFIX, 32);
		const id = generateHexId('atk_', 8);
		const tokenHash = await sha256Hex(token);
		const now = Date.now();
		const expiresAt = input.expiresAt ?? null;

		this.sql.exec(
			`INSERT INTO admin_tokens (id, name, token_hash, token_preview, role, created_by, created_at, expires_at, last_used_at, revoked)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
			id,
			input.name,
			tokenHash,
			makePreview(token),
			input.role,
			input.createdBy ?? null,
			now,
			expiresAt,
		);

		console.log(JSON.stringify({ breadcrumb: 'admin-token-created', id, role: input.role, hasExpiry: expiresAt !== null }));

		const record = this.getById(id);
		if (!record) throw new Error('admin token vanished immediately after insert');
		return { token, record };
	}

	/**
	 * Verify a candidate token value. Returns the token identity when valid (correct
	 * prefix, known hash, not revoked, not expired), null otherwise. Bumps last_used_at
	 * on success. Never throws on a bad token.
	 */
	async verifyToken(token: string): Promise<AdminTokenAuth | null> {
		if (!token.startsWith(ADMIN_TOKEN_PREFIX)) return null;
		const tokenHash = await sha256Hex(token);
		const rows = queryAll<AdminTokenRecord & { token_hash: string }>(
			this.sql,
			'SELECT * FROM admin_tokens WHERE token_hash = ?',
			tokenHash,
		);
		if (rows.length === 0) {
			console.log(JSON.stringify({ breadcrumb: 'admin-token-not-found' }));
			return null;
		}
		const row = rows[0];
		if (row.revoked) {
			console.log(JSON.stringify({ breadcrumb: 'admin-token-revoked', id: row.id }));
			return null;
		}
		if (row.expires_at !== null && row.expires_at <= Date.now()) {
			console.log(JSON.stringify({ breadcrumb: 'admin-token-expired', id: row.id }));
			return null;
		}
		this.sql.exec('UPDATE admin_tokens SET last_used_at = ? WHERE id = ?', Date.now(), row.id);
		return { id: row.id, name: row.name, role: row.role };
	}

	/** List all admin tokens (metadata only, most recent first). */
	listTokens(): AdminTokenRecord[] {
		return queryAll<AdminTokenRecord>(this.sql, `SELECT ${PUBLIC_COLS} FROM admin_tokens ORDER BY created_at DESC`);
	}

	/** Get one admin token's metadata by id, or null. */
	getById(id: string): AdminTokenRecord | null {
		const rows = queryAll<AdminTokenRecord>(this.sql, `SELECT ${PUBLIC_COLS} FROM admin_tokens WHERE id = ?`, id);
		return rows[0] ?? null;
	}

	/** Revoke a token by id. Returns false if it was already revoked or unknown. */
	revokeToken(id: string): boolean {
		const result = this.sql.exec('UPDATE admin_tokens SET revoked = 1 WHERE id = ? AND revoked = 0', id);
		return result.rowsWritten > 0;
	}

	/** Hard-delete a token by id. Returns false if unknown. */
	deleteToken(id: string): boolean {
		const result = this.sql.exec('DELETE FROM admin_tokens WHERE id = ?', id);
		return result.rowsWritten > 0;
	}

	/** Delete all expired tokens. Called by the retention cron. Returns number deleted. */
	deleteExpired(): number {
		const now = Date.now();
		const rows = queryAll<{ id: string }>(this.sql, 'SELECT id FROM admin_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
		if (rows.length === 0) return 0;
		this.sql.exec('DELETE FROM admin_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
		console.log(JSON.stringify({ breadcrumb: 'admin-tokens-expired-cleanup', count: rows.length }));
		return rows.length;
	}
}
