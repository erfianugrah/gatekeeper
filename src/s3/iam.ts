import { CredentialManager } from '../credential-manager';
import { queryAll } from '../sql';
import { MS_PER_DAY } from '../constants';
import { generateHexId } from '../crypto';
import { POLICY_VERSION } from '../policy-types';
import type { PolicyDocument, RequestContext } from '../policy-types';
import type { S3Credential, CachedS3Credential, CreateS3CredentialRequest } from './types';
import type { AuthResult } from '../types';

/** Access key ID prefix. */
const KEY_PREFIX = 'GK';

export class S3CredentialManager extends CredentialManager<S3Credential, CachedS3Credential> {
	/** Create tables if they don't exist. Call inside blockConcurrencyWhile. */
	initTables(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS s3_credentials (
				access_key_id TEXT PRIMARY KEY,
				secret_access_key TEXT NOT NULL,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				policy TEXT NOT NULL,
				created_by TEXT
			);
		`);

		// Migration: add upstream_token_id column for credential-to-upstream-R2 binding.
		const cols = queryAll<{ name: string }>(this.sql, `PRAGMA table_info('s3_credentials')`);
		if (!cols.some((c) => c.name === 'upstream_token_id')) {
			console.log(JSON.stringify({ migration: 's3_credentials', action: 'add_column_upstream_token_id', ts: new Date().toISOString() }));
			this.sql.exec(`ALTER TABLE s3_credentials ADD COLUMN upstream_token_id TEXT`);
		}
	}

	// ─── Credential creation ────────────────────────────────────────────

	/** Create an S3 credential with a policy document. */
	createCredential(req: CreateS3CredentialRequest): { credential: S3Credential } {
		const accessKeyId = this.generateAccessKeyId();
		const secretAccessKey = this.generateSecretAccessKey();
		const now = Date.now();
		const expiresAt = req.expires_in_days ? now + req.expires_in_days * MS_PER_DAY : null;

		const policyJson = JSON.stringify(req.policy);

		const upstreamTokenId = req.upstream_token_id || null;
		this.sql.exec(
			`INSERT INTO s3_credentials (access_key_id, secret_access_key, name, created_at, expires_at, revoked, policy, created_by, upstream_token_id)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
			accessKeyId,
			secretAccessKey,
			req.name,
			now,
			expiresAt,
			policyJson,
			req.created_by ?? null,
			upstreamTokenId,
		);

		const credential: S3Credential = {
			access_key_id: accessKeyId,
			secret_access_key: secretAccessKey,
			name: req.name,
			created_at: now,
			expires_at: expiresAt,
			revoked: 0,
			policy: policyJson,
			created_by: req.created_by ?? null,
			upstream_token_id: upstreamTokenId,
		};

		return { credential };
	}

	/**
	 * Atomically rotate a credential: create a new one with inherited config, then revoke the old one.
	 * Optional overrides let the caller change name or expiry on the new credential.
	 * Returns the new credential (with secret visible) and the old credential (now revoked).
	 */
	rotateCredential(
		accessKeyId: string,
		overrides?: { name?: string; expires_in_days?: number },
	): { oldCredential: S3Credential; newCredential: S3Credential } | null {
		const existing = this.getCredential(accessKeyId);
		if (!existing) return null;

		// getCredential redacts the secret — load the full row to check status
		const fullRow = this.loadFromSql(accessKeyId);
		if (!fullRow) return null;

		if (fullRow.revoked) return null;
		if (fullRow.expires_at && fullRow.expires_at < Date.now()) return null;

		let policy: PolicyDocument;
		try {
			policy = JSON.parse(fullRow.policy) as PolicyDocument;
		} catch {
			return null;
		}

		const req: CreateS3CredentialRequest = {
			name: overrides?.name ?? `${fullRow.name} (rotated)`,
			policy,
			created_by: fullRow.created_by ?? undefined,
			expires_in_days: overrides?.expires_in_days,
			upstream_token_id: fullRow.upstream_token_id ?? null!,
		};

		const { credential: newCredential } = this.createCredential(req);
		this.revokeCredential(accessKeyId);

		console.log(
			JSON.stringify({
				breadcrumb: 's3-rotate-credential',
				oldAccessKeyId: accessKeyId,
				newAccessKeyId: newCredential.access_key_id,
			}),
		);

		return { oldCredential: { ...fullRow, revoked: 1, secret_access_key: '***' }, newCredential };
	}

	/**
	 * Update mutable fields on an existing credential.
	 * Supports: name, expires_at.
	 */
	updateCredential(
		accessKeyId: string,
		updates: {
			name?: string;
			expires_at?: number | null;
		},
	): { credential: S3Credential } | null {
		const existing = this.getCredential(accessKeyId);
		if (!existing) return null;

		if (existing.credential.revoked) return null;

		const sets: string[] = [];
		const params: unknown[] = [];

		if (updates.name !== undefined) {
			sets.push('name = ?');
			params.push(updates.name);
		}

		if (updates.expires_at !== undefined) {
			sets.push('expires_at = ?');
			params.push(updates.expires_at);
		}

		if (sets.length === 0) return existing;

		params.push(accessKeyId);
		this.sql.exec(`UPDATE s3_credentials SET ${sets.join(', ')} WHERE access_key_id = ?`, ...params);
		this.cache.delete(accessKeyId);

		console.log(
			JSON.stringify({
				breadcrumb: 's3-update-credential',
				accessKeyId,
				updatedFields: Object.keys(updates).filter((k) => (updates as Record<string, unknown>)[k] !== undefined),
			}),
		);

		return this.getCredential(accessKeyId);
	}

	// ─── Credential queries ─────────────────────────────────────────────

	/** Count active (non-revoked) credentials bound to a given upstream R2 endpoint. */
	countCredentialsByUpstreamToken(upstreamTokenId: string): number {
		const rows = queryAll<{ cnt: number }>(
			this.sql,
			'SELECT COUNT(*) as cnt FROM s3_credentials WHERE upstream_token_id = ? AND revoked = 0',
			upstreamTokenId,
		);
		return rows.length > 0 ? rows[0].cnt : 0;
	}

	/** List S3 credentials. Optionally filter by status. Secret is redacted. */
	listCredentials(filter?: 'active' | 'revoked'): S3Credential[] {
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (filter === 'active') {
			conditions.push('revoked = 0');
			conditions.push('(expires_at IS NULL OR expires_at > ?)');
			params.push(Date.now());
		} else if (filter === 'revoked') {
			conditions.push('revoked = 1');
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
		const rows = queryAll<S3Credential>(
			this.sql,
			`SELECT access_key_id, '***' as secret_access_key, name, created_at, expires_at, revoked, policy, created_by, upstream_token_id
			 FROM s3_credentials${where} ORDER BY created_at DESC`,
			...params,
		);
		return rows;
	}

	/** Get a single credential by access_key_id. Secret is redacted. */
	getCredential(accessKeyId: string): { credential: S3Credential } | null {
		const rows = queryAll<S3Credential>(
			this.sql,
			`SELECT access_key_id, '***' as secret_access_key, name, created_at, expires_at, revoked, policy, created_by, upstream_token_id
			 FROM s3_credentials WHERE access_key_id = ?`,
			accessKeyId,
		);
		if (rows.length === 0) return null;
		return { credential: rows[0] };
	}

	/** Soft-revoke a credential. */
	revokeCredential(accessKeyId: string): boolean {
		return this.revokeById(accessKeyId);
	}

	/** Permanently delete a credential. Returns true if the row existed and was removed. */
	deleteCredential(accessKeyId: string): boolean {
		return this.deleteById(accessKeyId);
	}

	/** Revoke all non-revoked S3 credentials that have expired. Returns the count of revoked credentials. */
	revokeExpired(): number {
		const now = Date.now();
		const result = this.sql.exec(
			'UPDATE s3_credentials SET revoked = 1 WHERE revoked = 0 AND expires_at IS NOT NULL AND expires_at <= ?',
			now,
		);
		if (result.rowsWritten > 0) {
			this.cache.clear();
		}
		return result.rowsWritten;
	}

	// ─── Auth path (used by Sig V4 verification) ────────────────────────

	/** Look up the secret for a given access_key_id. Returns null if not found/revoked/expired. */
	getSecretForAuth(accessKeyId: string): string | null {
		const cached = this.getCachedOrLoad(accessKeyId);
		if (!cached) return null;

		const { credential } = cached;
		if (credential.revoked) return null;
		if (credential.expires_at && credential.expires_at < Date.now()) return null;

		return credential.secret_access_key;
	}

	/** Authorize a request against the credential's policy. */
	authorize(accessKeyId: string, contexts: RequestContext[]): AuthResult {
		const result = this.authorizeWithContexts(accessKeyId, contexts);
		if (result.authorized) {
			// Attach upstream_token_id so the S3 handler can use a pinned upstream
			const cached = this.getCachedOrLoad(accessKeyId);
			if (cached?.credential.upstream_token_id) {
				result.upstreamTokenId = cached.credential.upstream_token_id;
			}
		}
		return result;
	}

	// ─── Protected overrides ────────────────────────────────────────────

	protected revokeById(id: string): boolean {
		const result = this.sql.exec('UPDATE s3_credentials SET revoked = 1 WHERE access_key_id = ? AND revoked = 0', id);
		this.cache.delete(id);
		return result.rowsWritten > 0;
	}

	protected deleteById(id: string): boolean {
		const result = this.sql.exec('DELETE FROM s3_credentials WHERE access_key_id = ?', id);
		this.cache.delete(id);
		return result.rowsWritten > 0;
	}

	protected getById(id: string): { entity: S3Credential } | null {
		const result = this.getCredential(id);
		return result ? { entity: result.credential } : null;
	}

	protected getEntityFromCache(cached: CachedS3Credential): S3Credential {
		return cached.credential;
	}

	protected loadFromSql(id: string): S3Credential | null {
		// Load full credential (with secret) for auth path
		const rows = queryAll<S3Credential>(this.sql, 'SELECT * FROM s3_credentials WHERE access_key_id = ?', id);
		return rows.length > 0 ? rows[0] : null;
	}

	protected buildCacheEntry(entity: S3Credential, resolvedPolicy: PolicyDocument, cachedAt: number): CachedS3Credential {
		return { credential: entity, resolvedPolicy, cachedAt };
	}

	protected invalidCredentialMessage(): string {
		return 'Invalid S3 credential';
	}
	protected revokedMessage(): string {
		return 'S3 credential has been revoked';
	}
	protected expiredMessage(): string {
		return 'S3 credential has expired';
	}
	protected deniedMessage(denied: string[]): string {
		return `Access denied: ${denied.join(', ')}`;
	}

	// ─── Private helpers ────────────────────────────────────────────────

	/** Generate a GK-prefixed access key ID: GK + 18 uppercase hex chars. */
	private generateAccessKeyId(): string {
		const bytes = new Uint8Array(9);
		crypto.getRandomValues(bytes);
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase();
		return `${KEY_PREFIX}${hex}`;
	}

	/** Generate a 64-char hex secret access key (32 random bytes). */
	private generateSecretAccessKey(): string {
		return generateHexId('', 32);
	}
}
