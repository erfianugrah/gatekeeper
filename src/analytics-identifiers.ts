import { REDACTED_PLACEHOLDER } from './constants';
import { makePreview } from './crypto';

const KEY_PREVIEW_MARKER = '...';

/** Gatekeeper bearer key IDs currently use gw_ / sbp_ prefixes. */
function isGatewayBearerKey(value: string): boolean {
	return value.startsWith('gw_') || value.startsWith('sbp_');
}

/** True when the value is already a redacted preview. */
function isPreview(value: string): boolean {
	return value === REDACTED_PLACEHOLDER || value.includes(KEY_PREVIEW_MARKER);
}

/**
 * Convert a bearer key to a non-secret preview form.
 *
 * Non-bearer values are left unchanged so analytics fixtures/tests that use
 * arbitrary IDs remain readable.
 */
export function toSafeKeyPreview(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return REDACTED_PLACEHOLDER;
	if (isPreview(trimmed)) return trimmed;
	if (!isGatewayBearerKey(trimmed)) return trimmed;
	return makePreview(trimmed);
}

/** SHA-256 fingerprint (hex) of the raw bearer key value. */
export async function keyFingerprint(value: string): Promise<string> {
	const input = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', input);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build SQL filter predicates for analytics key filters.
 *
 * - Redacted previews: exact match on key_id.
 * - Non-bearer identifiers: exact match on key_id.
 * - Raw bearer keys: match by fingerprint (exact) with preview fallback for
 *   legacy rows that predate fingerprinting.
 */
export async function buildKeyIdFilter(
	value: string,
	columns: { keyId?: string; fingerprint?: string } = {},
): Promise<{ condition: string; params: string[] }> {
	const trimmed = value.trim();
	const keyIdColumn = columns.keyId ?? 'key_id';
	const fingerprintColumn = columns.fingerprint ?? 'key_fingerprint';

	if (!trimmed) {
		return { condition: `${keyIdColumn} = ?`, params: [trimmed] };
	}

	if (isPreview(trimmed) || !isGatewayBearerKey(trimmed)) {
		return { condition: `${keyIdColumn} = ?`, params: [trimmed] };
	}

	const fingerprint = await keyFingerprint(trimmed);
	const preview = toSafeKeyPreview(trimmed);
	return {
		condition: `(${fingerprintColumn} = ? OR ${keyIdColumn} = ?)`,
		params: [fingerprint, preview],
	};
}

/** Sanitize analytics rows before returning them from admin APIs. */
export function sanitizeKeyIdRow(row: Record<string, unknown>): Record<string, unknown> {
	const current = row.key_id;
	if (typeof current !== 'string') {
		const { key_fingerprint: _ignored, ...publicRow } = row;
		return publicRow;
	}
	const preview = toSafeKeyPreview(current);
	const { key_fingerprint: _ignored, ...publicRow } = row;
	return { ...publicRow, key_id: preview };
}

/** SQL predicate for migrating legacy raw bearer key IDs to previews. */
export const LEGACY_RAW_BEARER_KEY_SQL =
	"key_fingerprint IS NULL AND key_id NOT LIKE '%...%' AND (key_id LIKE 'gw_%' OR key_id LIKE 'sbp_%')";

/** SQL expression that rewrites key_id into a short non-secret preview. */
export const KEY_PREVIEW_SQL_EXPR =
	"CASE WHEN length(key_id) <= 10 THEN '****' ELSE substr(key_id, 1, 4) || '...' || substr(key_id, -4) END";
