/** Shared helpers for admin route handlers. */

import { AwsClient } from 'aws4fetch';
import { CF_API_BASE } from '../constants';
import type { AccessIdentity } from '../auth-access';

// ─── Identity resolution ────────────────────────────────────────────────────

/** Unverified prefix applied to self-reported created_by values (non-SSO callers). */
const UNVERIFIED_PREFIX = 'unverified:';

/**
 * Resolve created_by from SSO identity or request body.
 * SSO-verified emails are stored as-is; self-reported values from the request body
 * are prefixed with "unverified:" so audit trails distinguish trust levels.
 */
export function resolveCreatedBy(identity: AccessIdentity | undefined, rawCreatedBy: unknown): string | undefined {
	if (identity?.email) return identity.email;
	if (typeof rawCreatedBy === 'string' && rawCreatedBy.length > 0) return `${UNVERIFIED_PREFIX}${rawCreatedBy}`;
	return undefined;
}

// ─── Upstream credential validation ─────────────────────────────────────────

/** Maximum time for upstream validation probes (ms). */
const VALIDATE_TIMEOUT_MS = 10_000;

/** Validation result returned to admin callers. */
export interface ValidationWarning {
	code: number;
	message: string;
}

/**
 * Verify a Cloudflare API token by calling the CF token verification endpoint.
 * Returns null on success, or a warning object if the token is invalid/unreachable.
 */
export async function validateCfToken(token: string): Promise<ValidationWarning | null> {
	try {
		const res = await fetch(`${CF_API_BASE}/user/tokens/verify`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body: any = await res.json().catch(() => ({}));
			const detail = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
			return { code: 422, message: `Token validation failed: ${detail}` };
		}

		const body = await res.json<{ success?: boolean }>().catch(() => ({ success: false }));
		if (!body.success) {
			return { code: 422, message: 'Token validation failed: CF API returned success=false' };
		}

		return null;
	} catch (e: any) {
		const msg = e?.name === 'TimeoutError' ? 'validation request timed out' : (e?.message ?? 'unknown error');
		return { code: 422, message: `Token validation failed: ${msg}` };
	}
}

/**
 * Verify R2 credentials by issuing a ListBuckets (GET /) request against the endpoint.
 * Returns null on success, or a warning object if the credentials are invalid/unreachable.
 */
export async function validateR2Credentials(
	accessKeyId: string,
	secretAccessKey: string,
	endpoint: string,
): Promise<ValidationWarning | null> {
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
			return { code: 422, message: `R2 credential validation failed: ListBuckets returned HTTP ${res.status}` };
		}

		return null;
	} catch (e: any) {
		const msg = e?.name === 'TimeoutError' ? 'validation request timed out' : (e?.message ?? 'unknown error');
		return { code: 422, message: `R2 credential validation failed: ${msg}` };
	}
}
