/**
 * Cloudflare Access JWT validation + identity resolution.
 *
 * Validates JWTs from `Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie.
 * Uses crypto.subtle for RS256 signature verification.
 * JWKS keys are cached in-memory with a 1-hour TTL.
 *
 * Groups are resolved via the CF Access get-identity endpoint, since the JWT
 * itself does not include IDP group memberships for self-hosted applications.
 */

import { CF_ACCESS_JWT_HEADER, CF_ACCESS_COOKIE, JWT_CLOCK_SKEW_SEC } from './constants';

// ─── Types ──────────────────────────────────────────────────────────

export interface AccessIdentity {
	email: string;
	sub: string;
	type: string; // "app" for users, "service-token" for service tokens
	/** IDP group memberships resolved from the get-identity endpoint. Empty if unavailable. */
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
	identity_nonce?: string;
	/** IDP group memberships (may be present in some JWT configurations). */
	groups?: string[];
}

/** Group entry returned by the CF Access get-identity endpoint. */
interface AccessGroupEntry {
	id: string;
	name: string;
	email?: string;
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

// ─── Get-identity endpoint ──────────────────────────────────────────

/** Timeout for the get-identity call (ms). */
const GET_IDENTITY_TIMEOUT_MS = 5_000;

/**
 * Fetch the user's full identity from the CF Access get-identity endpoint.
 * Returns group names extracted from the response, or an empty array on failure.
 *
 * The endpoint accepts the CF_Authorization JWT as a cookie and returns the
 * full identity including IDP group memberships as `groups: [{ id, name, email }]`.
 */
export async function fetchAccessGroups(token: string, teamName: string): Promise<string[]> {
	try {
		const url = `https://${teamName}.cloudflareaccess.com/cdn-cgi/access/get-identity`;
		const resp = await fetch(url, {
			headers: { Cookie: `CF_Authorization=${token}` },
			signal: AbortSignal.timeout(GET_IDENTITY_TIMEOUT_MS),
		});

		if (!resp.ok) {
			console.log(
				JSON.stringify({
					breadcrumb: 'access-get-identity-failed',
					status: resp.status,
					teamName,
				}),
			);
			return [];
		}

		const body = (await resp.json()) as Record<string, unknown>;

		// Groups can live in multiple locations depending on IdP and CF Access config:
		//   1. body.groups — array of { id, name, email } (SCIM-synced groups)
		//   2. body.custom.groups — array of strings (custom OIDC claims)
		//   3. body.oidc_fields.groups — array of strings (OIDC claim passthrough)
		const candidates: unknown[] = [
			body.groups,
			(body.custom as Record<string, unknown> | undefined)?.groups,
			(body.oidc_fields as Record<string, unknown> | undefined)?.groups,
		];

		let groups: string[] = [];
		for (const candidate of candidates) {
			if (!Array.isArray(candidate) || candidate.length === 0) continue;
			// Groups can be plain strings or { id, name, email } objects
			groups = candidate.map((g: unknown) => (typeof g === 'string' ? g : (g as AccessGroupEntry)?.name)).filter(Boolean);
			// Deduplicate
			groups = [...new Set(groups)];
			break;
		}

		console.log(
			JSON.stringify({
				breadcrumb: 'access-get-identity-ok',
				groupCount: groups.length,
				groups,
				source:
					Array.isArray(body.groups) && body.groups.length > 0
						? 'groups'
						: Array.isArray((body.custom as any)?.groups) && (body.custom as any).groups.length > 0
							? 'custom.groups'
							: Array.isArray((body.oidc_fields as any)?.groups) && (body.oidc_fields as any).groups.length > 0
								? 'oidc_fields.groups'
								: 'none',
			}),
		);

		return groups;
	} catch (e: any) {
		console.log(
			JSON.stringify({
				breadcrumb: 'access-get-identity-error',
				error: e?.message ?? 'unknown',
				teamName,
			}),
		);
		return [];
	}
}

// ─── Main validation ────────────────────────────────────────────────

/**
 * Extract and validate a Cloudflare Access JWT from the request.
 * Returns the identity on success, or null if no valid JWT is present.
 *
 * Checks: signature (RS256), expiry, issuer, audience.
 * Groups are resolved from the get-identity endpoint when not present in the JWT.
 */
export async function validateAccessJwt(request: Request, teamName: string, aud: string): Promise<AccessIdentity | null> {
	// Extract JWT from header or cookie
	const token = request.headers.get(CF_ACCESS_JWT_HEADER) ?? getCookie(request, CF_ACCESS_COOKIE);
	if (!token) {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-missing' }));
		return null;
	}

	let jwt;
	try {
		jwt = parseJwt(token);
	} catch {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-parse-error' }));
		return null;
	}

	// Verify algorithm
	if (jwt.header.alg !== 'RS256') {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-bad-alg', alg: jwt.header.alg }));
		return null;
	}

	// Fetch JWKS and find matching key — retry once on kid miss (handles key rotation)
	let keys: JsonWebKey[];
	try {
		keys = await getJwks(teamName);
	} catch {
		console.log(JSON.stringify({ breadcrumb: 'access-jwks-fetch-failed' }));
		return null;
	}

	let jwk = keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === jwt.header.kid);
	if (!jwk) {
		// Key not found — may be a rotation; force-refresh JWKS and retry once
		console.log(JSON.stringify({ breadcrumb: 'access-jwks-kid-miss', kid: jwt.header.kid }));
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
	if (!valid) {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-signature-invalid' }));
		return null;
	}

	// Check expiry and issued-at (symmetric clock-skew tolerance)
	const now = Math.floor(Date.now() / 1000);
	if (jwt.payload.exp + JWT_CLOCK_SKEW_SEC < now) {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-expired', exp: jwt.payload.exp, now }));
		return null;
	}
	if (jwt.payload.iat > now + JWT_CLOCK_SKEW_SEC) {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-future-iat', iat: jwt.payload.iat, now }));
		return null;
	}

	// Check issuer
	const expectedIss = `https://${teamName}.cloudflareaccess.com`;
	if (jwt.payload.iss !== expectedIss) {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-bad-issuer', iss: jwt.payload.iss, expected: expectedIss }));
		return null;
	}

	// Check audience
	const audArray = Array.isArray(jwt.payload.aud) ? jwt.payload.aud : [jwt.payload.aud];
	if (!audArray.includes(aud)) {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-bad-audience' }));
		return null;
	}

	// Resolve groups — try JWT first, fall back to get-identity endpoint
	let groups = Array.isArray(jwt.payload.groups) && jwt.payload.groups.length > 0 ? jwt.payload.groups : [];

	if (groups.length === 0) {
		console.log(JSON.stringify({ breadcrumb: 'access-jwt-no-groups-in-token', email: jwt.payload.email }));
		groups = await fetchAccessGroups(token, teamName);
	}

	console.log(
		JSON.stringify({
			breadcrumb: 'access-jwt-validated',
			email: jwt.payload.email,
			type: jwt.payload.type ?? 'app',
			groupCount: groups.length,
			groups,
		}),
	);

	return {
		email: jwt.payload.email,
		sub: jwt.payload.sub,
		type: jwt.payload.type ?? 'app',
		groups,
	};
}
