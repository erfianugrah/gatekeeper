/**
 * Cloudflare Access JWT validation — no dependencies, ~80 lines.
 *
 * Validates JWTs from `Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie.
 * Uses crypto.subtle for RS256 signature verification.
 * JWKS keys are cached in-memory with a 1-hour TTL.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface AccessIdentity {
	email: string;
	sub: string;
	type: string; // "app" for users, "service-token" for service tokens
	/** IDP group memberships from the JWT (via OIDC groups scope). Empty if not present. */
	groups: string[];
}

interface JWKSResponse {
	keys: JsonWebKey[];
}

interface JWTHeader {
	kid: string;
	alg: string;
}

interface JWTPayload {
	sub: string;
	email: string;
	iss: string;
	aud: string[];
	exp: number;
	iat: number;
	type: string;
	/** IDP group memberships (via OIDC groups scope). May be absent. */
	groups?: string[];
}

// ─── JWKS cache ─────────────────────────────────────────────────────

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedKeys: JsonWebKey[] | null = null;
let cachedAt = 0;

/** Clear the JWKS cache. Exported for testing only. */
export function __testClearJwksCache(): void {
	cachedKeys = null;
	cachedAt = 0;
}

async function getJwks(teamName: string): Promise<JsonWebKey[]> {
	const now = Date.now();
	if (cachedKeys && now - cachedAt < JWKS_TTL_MS) {
		return cachedKeys;
	}

	const url = `https://${teamName}.cloudflareaccess.com/cdn-cgi/access/certs`;
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`Failed to fetch JWKS from ${url}: HTTP ${resp.status}`);
	}

	const data = (await resp.json()) as JWKSResponse;
	cachedKeys = data.keys;
	cachedAt = now;
	return data.keys;
}

// ─── JWT parsing ────────────────────────────────────────────────────

function base64urlDecode(s: string): Uint8Array {
	// Restore base64 padding
	const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
	const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function parseJwt(token: string): { header: JWTHeader; payload: JWTPayload; signedData: string; signature: string } {
	const parts = token.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid JWT: expected 3 parts');
	}

	const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0]))) as JWTHeader;
	const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1]))) as JWTPayload;

	return {
		header,
		payload,
		signedData: `${parts[0]}.${parts[1]}`,
		signature: parts[2],
	};
}

// ─── Cookie extraction ──────────────────────────────────────────────

function getCookie(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get('Cookie');
	if (!cookieHeader) return null;

	for (const pair of cookieHeader.split(';')) {
		const [key, ...rest] = pair.split('=');
		if (key.trim() === name) {
			return rest.join('=').trim();
		}
	}
	return null;
}

// ─── Main validation ────────────────────────────────────────────────

/**
 * Extract and validate a Cloudflare Access JWT from the request.
 * Returns the identity on success, or null if no valid JWT is present.
 *
 * Checks: signature (RS256), expiry, issuer, audience.
 */
export async function validateAccessJwt(request: Request, teamName: string, aud: string): Promise<AccessIdentity | null> {
	// Extract JWT from header or cookie
	const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? getCookie(request, 'CF_Authorization');
	if (!token) return null;

	let jwt;
	try {
		jwt = parseJwt(token);
	} catch {
		return null;
	}

	// Verify algorithm
	if (jwt.header.alg !== 'RS256') return null;

	// Fetch JWKS and find matching key — retry once on kid miss (handles key rotation)
	let keys: JsonWebKey[];
	try {
		keys = await getJwks(teamName);
	} catch {
		return null;
	}

	let jwk = keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === jwt.header.kid);
	if (!jwk) {
		// Key not found — may be a rotation; force-refresh JWKS and retry once
		try {
			cachedKeys = null;
			cachedAt = 0;
			keys = await getJwks(teamName);
		} catch {
			return null;
		}
		jwk = keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === jwt.header.kid);
		if (!jwk) return null;
	}

	// Import key and verify signature
	let cryptoKey: CryptoKey;
	try {
		cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
	} catch {
		return null;
	}

	const signatureBytes = base64urlDecode(jwt.signature);
	const dataBytes = new TextEncoder().encode(jwt.signedData);

	const valid = await crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		cryptoKey,
		signatureBytes as unknown as ArrayBuffer,
		dataBytes as unknown as ArrayBuffer,
	);
	if (!valid) return null;

	// Check expiry and issued-at
	const now = Math.floor(Date.now() / 1000);
	if (jwt.payload.exp < now) return null;
	if (jwt.payload.iat > now + 60) return null; // 60s skew tolerance for future iat

	// Check issuer
	const expectedIss = `https://${teamName}.cloudflareaccess.com`;
	if (jwt.payload.iss !== expectedIss) return null;

	// Check audience
	const audArray = Array.isArray(jwt.payload.aud) ? jwt.payload.aud : [jwt.payload.aud];
	if (!audArray.includes(aud)) return null;

	return {
		email: jwt.payload.email,
		sub: jwt.payload.sub,
		type: jwt.payload.type ?? 'app',
		groups: Array.isArray(jwt.payload.groups) ? jwt.payload.groups : [],
	};
}
