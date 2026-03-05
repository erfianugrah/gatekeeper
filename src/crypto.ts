/**
 * Shared cryptographic utilities.
 * Used by admin auth (timing-safe key comparison) and S3 Sig V4 verification.
 */

/**
 * Constant-time string comparison using HMAC-SHA256.
 * Prevents timing attacks by comparing fixed-length MACs instead of raw strings.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const hmacKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode('gatekeeper-admin-compare'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const [macA, macB] = await Promise.all([
		crypto.subtle.sign('HMAC', hmacKey, encoder.encode(a)),
		crypto.subtle.sign('HMAC', hmacKey, encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(macA, macB);
}

/** Type-safe helper to avoid repetitive `as unknown as T[]` on every DO SQLite query. */
export function queryAll<T>(sql: SqlStorage, query: string, ...params: unknown[]): T[] {
	return sql.exec(query, ...params).toArray() as unknown as T[];
}
