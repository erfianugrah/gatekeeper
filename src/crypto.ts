/**
 * Shared cryptographic utilities.
 * Used by admin auth (timing-safe key comparison), ID generation, and secret redaction.
 */

import { HMAC_COMPARE_LABEL, REDACTED_PLACEHOLDER } from './constants';

/**
 * Constant-time string comparison using HMAC-SHA256.
 * Prevents timing attacks by comparing fixed-length MACs instead of raw strings.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(HMAC_COMPARE_LABEL), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	const [macA, macB] = await Promise.all([
		crypto.subtle.sign('HMAC', hmacKey, encoder.encode(a)),
		crypto.subtle.sign('HMAC', hmacKey, encoder.encode(b)),
	]);
	// timingSafeEqual is a Workers runtime extension to SubtleCrypto — not in standard TS lib types
	return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(macA, macB);
}

/** SHA-256 hash of a string, returned as lowercase hex. Deterministic, so safe as a lookup key. */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a short random flight identifier (8 hex chars). */
export function generateFlightId(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a random hex ID with the given prefix and byte length. */
export function generateHexId(prefix: string, byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Create a preview string: first 4 + "..." + last 4 chars. Returns a redacted placeholder for short values. */
export function makePreview(secret: string): string {
	if (secret.length <= 10) return REDACTED_PLACEHOLDER;
	return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
