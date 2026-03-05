import type { PolicyDocument, RequestContext } from '../policy-types';
import { evaluatePolicy } from '../policy-engine';
import type { S3Credential, CachedS3Credential, CreateS3CredentialRequest } from './types';
import type { AuthResult } from '../types';

/** Type-safe helper to avoid repetitive `as unknown as T[]` on every query. */
function queryAll<T>(sql: SqlStorage, query: string, ...params: unknown[]): T[] {
	return sql.exec(query, ...params).toArray() as unknown as T[];
}

/** Access key ID prefix. */
const KEY_PREFIX = 'GK';

export class S3CredentialManager {
	private sql: SqlStorage;
	private cache: Map<string, CachedS3Credential> = new Map();
	private cacheTtlMs: number;

	constructor(sql: SqlStorage, cacheTtlMs: number = 60_000) {
		this.sql = sql;
		this.cacheTtlMs = cacheTtlMs;
	}

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
	}

	// ─── Credential creation ────────────────────────────────────────────

	/** Create an S3 credential with a policy document. */
	createCredential(req: CreateS3CredentialRequest): { credential: S3Credential } {
		const accessKeyId = this.generateAccessKeyId();
		const secretAccessKey = this.generateSecretAccessKey();
		const now = Date.now();
		const expiresAt = req.expires_in_days
			? now + req.expires_in_days * 86400_000
			: null;

		const policyJson = JSON.stringify(req.policy);

		this.sql.exec(
			`INSERT INTO s3_credentials (access_key_id, secret_access_key, name, created_at, expires_at, revoked, policy, created_by)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
			accessKeyId,
			secretAccessKey,
			req.name,
			now,
			expiresAt,
			policyJson,
			req.created_by ?? null,
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
		};

		return { credential };
	}

	// ─── Credential queries ─────────────────────────────────────────────

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
			`SELECT access_key_id, '***' as secret_access_key, name, created_at, expires_at, revoked, policy, created_by
			 FROM s3_credentials${where} ORDER BY created_at DESC`,
			...params,
		);
		return rows;
	}

	/** Get a single credential by access_key_id. Secret is redacted. */
	getCredential(accessKeyId: string): { credential: S3Credential } | null {
		const rows = queryAll<S3Credential>(
			this.sql,
			`SELECT access_key_id, '***' as secret_access_key, name, created_at, expires_at, revoked, policy, created_by
			 FROM s3_credentials WHERE access_key_id = ?`,
			accessKeyId,
		);
		if (rows.length === 0) return null;
		return { credential: rows[0] };
	}

	/** Soft-revoke a credential. */
	revokeCredential(accessKeyId: string): boolean {
		const result = this.sql.exec(
			'UPDATE s3_credentials SET revoked = 1 WHERE access_key_id = ? AND revoked = 0',
			accessKeyId,
		);
		this.cache.delete(accessKeyId);
		return result.rowsWritten > 0;
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
		const cached = this.getCachedOrLoad(accessKeyId);
		if (!cached) {
			return { authorized: false, error: 'Invalid S3 credential' };
		}

		const { credential, resolvedPolicy } = cached;

		if (credential.revoked) {
			return { authorized: false, error: 'S3 credential has been revoked' };
		}

		if (credential.expires_at && credential.expires_at < Date.now()) {
			return { authorized: false, error: 'S3 credential has expired' };
		}

		if (!evaluatePolicy(resolvedPolicy, contexts)) {
			const denied: string[] = [];
			for (const ctx of contexts) {
				if (!evaluatePolicy(resolvedPolicy, [ctx])) {
					denied.push(`${ctx.action} on ${ctx.resource}`);
				}
			}
			return {
				authorized: false,
				error: `Access denied: ${denied.join(', ')}`,
				denied,
			};
		}

		return { authorized: true };
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private getCachedOrLoad(accessKeyId: string): CachedS3Credential | null {
		const cached = this.cache.get(accessKeyId);
		if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
			return cached;
		}

		// Load full credential (with secret) for auth path
		const rows = queryAll<S3Credential>(
			this.sql,
			'SELECT * FROM s3_credentials WHERE access_key_id = ?',
			accessKeyId,
		);
		if (rows.length === 0) {
			this.cache.delete(accessKeyId);
			return null;
		}

		const credential = rows[0];
		let resolvedPolicy: PolicyDocument;
		try {
			resolvedPolicy = JSON.parse(credential.policy) as PolicyDocument;
		} catch {
			resolvedPolicy = { version: '2025-01-01', statements: [] };
		}

		const entry: CachedS3Credential = {
			credential,
			resolvedPolicy,
			cachedAt: Date.now(),
		};
		this.cache.set(accessKeyId, entry);
		return entry;
	}

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
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}
}
