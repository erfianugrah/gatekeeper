/** Shared helpers for admin route handlers. */

import { AwsClient } from 'aws4fetch';
import { CF_API_BASE } from '../constants';
import { logAuditEvent } from '../audit-log';
import type { AuditEvent } from '../audit-log';
import type { Context } from 'hono';
import type { AccessIdentity } from '../auth-access';
import type { HonoEnv } from '../types';

// ─── Identity resolution ────────────────────────────────────────────────────

/** Unverified prefix applied to self-reported created_by values (non-SSO callers). */
const UNVERIFIED_PREFIX = 'unverified:';

/**
 * Resolve created_by from SSO identity or request body.
 * SSO-verified emails are stored as-is; self-reported values from the request body
 * are prefixed with "unverified:" so audit trails distinguish trust levels.
 * Falls back to "via admin key" when no identity or explicit value is provided.
 */
export function resolveCreatedBy(identity: AccessIdentity | undefined, rawCreatedBy: unknown): string {
	if (identity?.email) return identity.email;
	if (typeof rawCreatedBy === 'string' && rawCreatedBy.length > 0) return `${UNVERIFIED_PREFIX}${rawCreatedBy}`;
	return 'via admin key';
}

// ─── Audit logging ──────────────────────────────────────────────────────────

/**
 * Emit a persistent audit event via waitUntil(). Resolves the actor from
 * the Hono context's accessIdentity (SSO email) or falls back to "via admin key".
 */
export function emitAudit(c: Context<HonoEnv>, event: Omit<AuditEvent, 'actor'> & { actor?: string }): void {
	const identity = c.get('accessIdentity');
	const actor = event.actor ?? (identity?.email ? identity.email : 'via admin key');
	const db = c.env.ANALYTICS_DB;
	if (!db) return; // analytics DB not bound — skip silently
	c.executionCtx.waitUntil(logAuditEvent(db, { ...event, actor }));
}

// ─── Upstream credential validation ─────────────────────────────────────────

/** Maximum time for upstream validation probes (ms). */
const VALIDATE_TIMEOUT_MS = 10_000;

/** Validation result returned to admin callers. */
export interface ValidationWarning {
	code: number;
	message: string;
}

// ─── CF API helpers ─────────────────────────────────────────────────────────

/** Standard auth header for CF API calls. */
function cfAuthHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

/**
 * Verify a Cloudflare API token is active, then probe declared zone/account
 * permissions. Returns an array of warnings (empty = all good).
 *
 * Checks performed:
 * 1. Token verify (POST /user/tokens/verify) — is the token active?
 * 2. Zone access — for each declared zone_id, GET /zones/{id}
 *    (for wildcard tokens, GET /zones to report accessible zones)
 * 3. Account access — for account-scoped tokens, GET /accounts/{id}
 */
export async function validateCfToken(token: string, scopeType: 'zone' | 'account', scopeIds: string[]): Promise<ValidationWarning[]> {
	const warnings: ValidationWarning[] = [];

	// Step 1: Verify token is active
	const verifyWarning = await verifyCfTokenActive(token);
	if (verifyWarning) {
		// If the token itself is invalid, skip permission probes
		warnings.push(verifyWarning);
		return warnings;
	}

	// Step 2: Probe declared scope permissions
	if (scopeType === 'zone') {
		const zoneWarnings = await probeZoneAccess(token, scopeIds);
		warnings.push(...zoneWarnings);
	} else {
		const accountWarnings = await probeAccountAccess(token, scopeIds);
		warnings.push(...accountWarnings);
	}

	return warnings;
}

/** Verify a CF API token is active via /user/tokens/verify. */
async function verifyCfTokenActive(token: string): Promise<ValidationWarning | null> {
	try {
		const res = await fetch(`${CF_API_BASE}/user/tokens/verify`, {
			method: 'GET',
			headers: cfAuthHeaders(token),
			signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body: any = await res.json().catch(() => ({}));
			const detail = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-token-failed', status: res.status, detail }));
			return { code: 422, message: `Token validation failed: ${detail}` };
		}

		const body = await res.json<{ success?: boolean }>().catch(() => ({ success: false }));
		if (!body.success) {
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-token-not-success' }));
			return { code: 422, message: 'Token validation failed: CF API returned success=false' };
		}

		console.log(JSON.stringify({ breadcrumb: 'validate-cf-token-ok' }));
		return null;
	} catch (e: any) {
		const msg = e?.name === 'TimeoutError' ? 'validation request timed out' : (e?.message ?? 'unknown error');
		console.log(JSON.stringify({ breadcrumb: 'validate-cf-token-error', error: msg }));
		return { code: 422, message: `Token validation failed: ${msg}` };
	}
}

/** Probe zone access for each declared zone_id. For wildcard, list accessible zones. */
async function probeZoneAccess(token: string, zoneIds: string[]): Promise<ValidationWarning[]> {
	const warnings: ValidationWarning[] = [];

	if (zoneIds.length === 1 && zoneIds[0] === '*') {
		// Wildcard: list zones to report what the token can see
		try {
			const res = await fetch(`${CF_API_BASE}/zones?per_page=1`, {
				headers: cfAuthHeaders(token),
				signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.log(JSON.stringify({ breadcrumb: 'validate-cf-zone-wildcard-failed', status: res.status }));
				warnings.push({ code: 422, message: `Wildcard zone check failed: GET /zones returned HTTP ${res.status}` });
			} else {
				const body: any = await res.json().catch(() => ({}));
				const count: number = body?.result_info?.total_count ?? 0;
				console.log(JSON.stringify({ breadcrumb: 'validate-cf-zone-wildcard-ok', accessibleZones: count }));
				if (count === 0) {
					warnings.push({ code: 422, message: 'Token has wildcard scope but can access 0 zones — verify token permissions' });
				}
			}
		} catch (e: any) {
			const msg = e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? 'unknown error');
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-zone-wildcard-error', error: msg }));
			warnings.push({ code: 422, message: `Wildcard zone check failed: ${msg}` });
		}
		return warnings;
	}

	// Specific zone IDs: probe each one
	const probes = zoneIds.map(async (zoneId) => {
		try {
			const res = await fetch(`${CF_API_BASE}/zones/${zoneId}`, {
				headers: cfAuthHeaders(token),
				signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.log(JSON.stringify({ breadcrumb: 'validate-cf-zone-probe-failed', zoneId, status: res.status }));
				return {
					code: 422,
					message: `Zone ${zoneId}: token cannot access this zone (HTTP ${res.status})`,
				} as ValidationWarning;
			}
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-zone-probe-ok', zoneId }));
			return null;
		} catch (e: any) {
			const msg = e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? 'unknown error');
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-zone-probe-error', zoneId, error: msg }));
			return { code: 422, message: `Zone ${zoneId}: access check failed (${msg})` } as ValidationWarning;
		}
	});

	const results = await Promise.all(probes);
	for (const w of results) {
		if (w) warnings.push(w);
	}

	return warnings;
}

/** Probe account access for each declared account_id. */
async function probeAccountAccess(token: string, accountIds: string[]): Promise<ValidationWarning[]> {
	const warnings: ValidationWarning[] = [];

	if (accountIds.length === 1 && accountIds[0] === '*') {
		// Wildcard: list accounts to report what the token can see
		try {
			const res = await fetch(`${CF_API_BASE}/accounts?per_page=1`, {
				headers: cfAuthHeaders(token),
				signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.log(JSON.stringify({ breadcrumb: 'validate-cf-account-wildcard-failed', status: res.status }));
				warnings.push({ code: 422, message: `Wildcard account check failed: GET /accounts returned HTTP ${res.status}` });
			} else {
				const body: any = await res.json().catch(() => ({}));
				const count: number = body?.result_info?.total_count ?? 0;
				console.log(JSON.stringify({ breadcrumb: 'validate-cf-account-wildcard-ok', accessibleAccounts: count }));
				if (count === 0) {
					warnings.push({ code: 422, message: 'Token has wildcard scope but can access 0 accounts — verify token permissions' });
				}
			}
		} catch (e: any) {
			const msg = e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? 'unknown error');
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-account-wildcard-error', error: msg }));
			warnings.push({ code: 422, message: `Wildcard account check failed: ${msg}` });
		}
		return warnings;
	}

	// Specific account IDs: probe each one
	const probes = accountIds.map(async (accountId) => {
		try {
			const res = await fetch(`${CF_API_BASE}/accounts/${accountId}`, {
				headers: cfAuthHeaders(token),
				signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.log(JSON.stringify({ breadcrumb: 'validate-cf-account-probe-failed', accountId, status: res.status }));
				return {
					code: 422,
					message: `Account ${accountId}: token cannot access this account (HTTP ${res.status})`,
				} as ValidationWarning;
			}
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-account-probe-ok', accountId }));
			return null;
		} catch (e: any) {
			const msg = e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? 'unknown error');
			console.log(JSON.stringify({ breadcrumb: 'validate-cf-account-probe-error', accountId, error: msg }));
			return { code: 422, message: `Account ${accountId}: access check failed (${msg})` } as ValidationWarning;
		}
	});

	const results = await Promise.all(probes);
	for (const w of results) {
		if (w) warnings.push(w);
	}

	return warnings;
}

// ─── R2 credential validation ───────────────────────────────────────────────

/**
 * Verify R2 credentials by issuing a ListBuckets (GET /) request against the endpoint,
 * then compare the returned bucket names against the declared bucket_names.
 * Returns an array of warnings (empty = all good).
 */
export async function validateR2Credentials(
	accessKeyId: string,
	secretAccessKey: string,
	endpoint: string,
	declaredBuckets: string[],
): Promise<ValidationWarning[]> {
	const warnings: ValidationWarning[] = [];

	try {
		const client = new AwsClient({
			accessKeyId,
			secretAccessKey,
			service: 's3',
			region: 'auto',
		});

		const signed = await client.sign(`${endpoint}/`, {
			method: 'GET',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
		});

		const res = await fetch(signed, {
			signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
		});

		if (!res.ok) {
			console.log(JSON.stringify({ breadcrumb: 'validate-r2-creds-failed', endpoint, status: res.status }));
			warnings.push({ code: 422, message: `R2 credential validation failed: ListBuckets returned HTTP ${res.status}` });
			return warnings;
		}

		// Parse the ListBuckets XML to extract bucket names
		const xml = await res.text();
		const accessibleBuckets = parseBucketNamesFromXml(xml);
		console.log(JSON.stringify({ breadcrumb: 'validate-r2-creds-ok', endpoint, accessibleBucketCount: accessibleBuckets.length }));

		// Compare declared buckets against accessible buckets
		if (declaredBuckets.length === 1 && declaredBuckets[0] === '*') {
			// Wildcard — just report how many buckets are accessible
			if (accessibleBuckets.length === 0) {
				warnings.push({ code: 422, message: 'R2 credentials have wildcard scope but can access 0 buckets — verify permissions' });
			}
		} else {
			// Check each declared bucket name
			const accessibleSet = new Set(accessibleBuckets);
			for (const bucket of declaredBuckets) {
				if (!accessibleSet.has(bucket)) {
					warnings.push({ code: 422, message: `Bucket "${bucket}": not found in accessible buckets list` });
				}
			}
		}

		return warnings;
	} catch (e: any) {
		const msg = e?.name === 'TimeoutError' ? 'validation request timed out' : (e?.message ?? 'unknown error');
		console.log(JSON.stringify({ breadcrumb: 'validate-r2-creds-error', endpoint, error: msg }));
		warnings.push({ code: 422, message: `R2 credential validation failed: ${msg}` });
		return warnings;
	}
}

/** Extract bucket names from an S3 ListBuckets XML response. */
export function parseBucketNamesFromXml(xml: string): string[] {
	const names: string[] = [];
	const re = /<Name>([^<]+)<\/Name>/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml)) !== null) {
		names.push(match[1]);
	}
	return names;
}
