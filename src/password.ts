/**
 * Password hashing and verification using Web Crypto PBKDF2-SHA256.
 * No external dependencies — runs natively in the Workers runtime.
 *
 * Format: `$pbkdf2-sha256$iterations$base64salt$base64hash`
 * Similar to PHC string format for interoperability and self-describing storage.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** PBKDF2 iteration count — OWASP minimum is 600k for SHA-256 (2023). */
const ITERATIONS = 600_000;

/** Salt length in bytes. 16 bytes = 128 bits, standard recommendation. */
const SALT_BYTES = 16;

/** Derived key length in bytes. 32 bytes = 256 bits. */
const KEY_BYTES = 32;

/** PHC-style prefix for the stored hash string. */
const HASH_PREFIX = '$pbkdf2-sha256$';

// ─── Helpers ────────────────────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer as ArrayBuffer;
}

// ─── Core ───────────────────────────────────────────────────────────────────

/** Derive a PBKDF2-SHA256 key from a password and salt. */
async function deriveKey(password: string, salt: ArrayBuffer, iterations: number): Promise<ArrayBuffer> {
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	return crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			hash: 'SHA-256',
			salt,
			iterations,
		},
		keyMaterial,
		KEY_BYTES * 8,
	);
}

/**
 * Hash a plaintext password. Returns a PHC-style string:
 * `$pbkdf2-sha256$600000$<base64salt>$<base64hash>`
 */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await deriveKey(password, salt.buffer as ArrayBuffer, ITERATIONS);
	return `${HASH_PREFIX}${ITERATIONS}$${toBase64(salt.buffer as ArrayBuffer)}$${toBase64(hash)}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 * Returns true if the password matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	if (!stored.startsWith(HASH_PREFIX)) return false;

	const parts = stored.slice(HASH_PREFIX.length).split('$');
	if (parts.length !== 3) return false;

	const iterations = Number(parts[0]);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;

	const salt = fromBase64(parts[1]);
	const expectedHash = fromBase64(parts[2]);

	const actualHash = await deriveKey(password, salt, iterations);

	// Timing-safe comparison via HMAC — same pattern as crypto.ts
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode('gatekeeper-password-compare'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const [macA, macB] = await Promise.all([crypto.subtle.sign('HMAC', key, expectedHash), crypto.subtle.sign('HMAC', key, actualHash)]);
	return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(macA, macB);
}
