/** Shared helpers for admin route handlers. */

import { AwsClient } from 'aws4fetch';
import { CF_API_BASE } from '../constants';
import { SUPABASE_API_BASE, SUPABASE_PROJECT_HOST, SUPABASE_METRICS_PATH } from '../supabase/constants';
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

// ─── Supabase credential validation ─────────────────────────────────────────

/**
 * Validate a Supabase credential against the real upstream it will be swapped in for.
 *
 *  - supabase (PAT)      → GET https://api.supabase.com/v1/projects with the Bearer PAT.
 *                          200 = active; 401/403 = rejected. For specific project refs,
 *                          confirm each ref appears in the accessible-projects list; for
 *                          wildcard, warn if the PAT can see 0 projects (mirrors the CF probe).
 *  - supabase_metrics    → GET https://<ref>.supabase.co/customer/v1/privileged/metrics with
 *                          HTTP Basic for each concrete ref. 401/403 = secret rejected.
 *                          Wildcard metrics tokens cannot be verified without a ref → skipped.
 *
 * Returns an array of warnings (empty = all good). Never throws.
 */
export async function validateSupabaseToken(
	token: string,
	scopeType: 'supabase' | 'supabase_metrics',
	scopeIds: string[],
	username?: string,
): Promise<ValidationWarning[]> {
	if (scopeType === 'supabase_metrics') {
		return validateSupabaseMetrics(token, scopeIds, username ?? 'service_role');
	}
	return validateSupabasePat(token, scopeIds);
}

/** Verify a Supabase PAT via GET /v1/projects and check declared project-ref coverage. */
async function validateSupabasePat(pat: string, scopeIds: string[]): Promise<ValidationWarning[]> {
	const warnings: ValidationWarning[] = [];
	try {
		const res = await fetch(`${SUPABASE_API_BASE}/v1/projects`, {
			headers: { Authorization: `Bearer ${pat}` },
			signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
		});
		if (res.status === 401 || res.status === 403) {
			console.log(JSON.stringify({ breadcrumb: 'validate-supabase-pat-rejected', status: res.status }));
			return [{ code: 422, message: `Supabase PAT validation failed: Management API rejected the token (HTTP ${res.status})` }];
		}
		if (!res.ok) {
			console.log(JSON.stringify({ breadcrumb: 'validate-supabase-pat-failed', status: res.status }));
			return [{ code: 422, message: `Supabase PAT validation failed: GET /v1/projects returned HTTP ${res.status}` }];
		}
		const projects: any = await res.json().catch(() => []);
		const accessibleRefs: string[] = Array.isArray(projects)
			? projects.map((p) => p?.id).filter((x): x is string => typeof x === 'string')
			: [];
		const isWildcard = scopeIds.length === 1 && scopeIds[0] === '*';
		if (isWildcard) {
			console.log(JSON.stringify({ breadcrumb: 'validate-supabase-pat-ok', accessibleProjects: accessibleRefs.length }));
			if (accessibleRefs.length === 0) {
				warnings.push({ code: 422, message: 'Supabase PAT has wildcard scope but can access 0 projects — verify token permissions' });
			}
		} else {
			for (const ref of scopeIds) {
				if (ref === '*') continue;
				if (!accessibleRefs.includes(ref)) {
					warnings.push({ code: 422, message: `Supabase project '${ref}' is not accessible with this PAT` });
				}
			}
			console.log(JSON.stringify({ breadcrumb: 'validate-supabase-pat-ok', declaredRefs: scopeIds.length, warnings: warnings.length }));
		}
		return warnings;
	} catch (e: any) {
		const msg = e?.name === 'TimeoutError' ? 'validation request timed out' : (e?.message ?? 'unknown error');
		console.log(JSON.stringify({ breadcrumb: 'validate-supabase-pat-error', error: msg }));
		return [{ code: 422, message: `Supabase PAT validation failed: ${msg}` }];
	}
}

/** Verify a Supabase metrics secret via the per-project metrics endpoint (HTTP Basic) for each concrete ref. */
async function validateSupabaseMetrics(secret: string, scopeIds: string[], username: string): Promise<ValidationWarning[]> {
	const warnings: ValidationWarning[] = [];
	const refs = scopeIds.filter((r) => r !== '*');
	if (refs.length === 0) {
		// Wildcard metrics token — the metrics endpoint is per-project, so there is nothing to probe.
		console.log(JSON.stringify({ breadcrumb: 'validate-supabase-metrics-skipped-wildcard' }));
		return warnings;
	}
	const basic = btoa(`${username}:${secret}`);
	const probes = refs.map(async (ref): Promise<ValidationWarning | null> => {
		try {
			const res = await fetch(`${SUPABASE_PROJECT_HOST(ref)}${SUPABASE_METRICS_PATH}`, {
				headers: { Authorization: `Basic ${basic}` },
				signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
			});
			if (res.status === 401 || res.status === 403) {
				console.log(JSON.stringify({ breadcrumb: 'validate-supabase-metrics-rejected', ref, status: res.status }));
				return { code: 422, message: `Supabase metrics secret rejected for project '${ref}' (HTTP ${res.status})` };
			}
			console.log(JSON.stringify({ breadcrumb: 'validate-supabase-metrics-ok', ref, status: res.status }));
			return null;
		} catch (e: any) {
			const msg = e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? 'unknown error');
			console.log(JSON.stringify({ breadcrumb: 'validate-supabase-metrics-error', ref, error: msg }));
			return { code: 422, message: `Supabase metrics check for '${ref}' failed: ${msg}` };
		}
	});
	for (const w of await Promise.all(probes)) if (w) warnings.push(w);
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
