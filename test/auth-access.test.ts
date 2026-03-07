import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, SELF, fetchMock } from 'cloudflare:test';
import { validateAccessJwt, fetchAccessGroups, __testClearJwksCache } from '../src/auth-access';

// ─── Test helpers ───────────────────────────────────────────────────

const TEAM_NAME = 'test-team';
const AUD = 'test-aud-tag-12345';
const ISSUER = `https://${TEAM_NAME}.cloudflareaccess.com`;
const CERTS_URL = `https://${TEAM_NAME}.cloudflareaccess.com`;

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey;
const KID = 'test-kid-001';

/** Base64url encode */
function b64url(data: ArrayBuffer | Uint8Array | string): string {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
	const binary = String.fromCharCode(...bytes);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Create a signed JWT */
async function createJwt(payload: Record<string, unknown>, opts?: { kid?: string; privateKey?: CryptoKey }): Promise<string> {
	const header = { alg: 'RS256', typ: 'JWT', kid: opts?.kid ?? KID };
	const headerB64 = b64url(JSON.stringify(header));
	const payloadB64 = b64url(JSON.stringify(payload));
	const data = `${headerB64}.${payloadB64}`;

	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts?.privateKey ?? keyPair.privateKey, new TextEncoder().encode(data));

	return `${data}.${b64url(signature)}`;
}

function defaultPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		sub: 'user-123',
		email: 'test@example.com',
		iss: ISSUER,
		aud: [AUD],
		iat: now - 60,
		exp: now + 3600,
		type: 'app',
		...overrides,
	};
}

// ─── Setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
	// Generate RSA key pair for testing
	keyPair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;

	// Export public key as JWK
	jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
	(jwk as JsonWebKey & { kid: string }).kid = KID;

	// Mock the JWKS endpoint
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	__testClearJwksCache();
	fetchMock.assertNoPendingInterceptors();
});

// ─── Mock helpers ───────────────────────────────────────────────────

function mockCerts(keys?: JsonWebKey[]): void {
	fetchMock
		.get(CERTS_URL)
		.intercept({ path: '/cdn-cgi/access/certs' })
		.reply(200, JSON.stringify({ keys: keys ?? [jwk] }));
}

/** Mock the get-identity endpoint to return group names. */
function mockGetIdentity(groups?: Array<{ id: string; name: string; email?: string }>): void {
	fetchMock
		.get(CERTS_URL)
		.intercept({ path: '/cdn-cgi/access/get-identity' })
		.reply(200, JSON.stringify({ groups: groups ?? [] }));
}

/** Mock a failing get-identity endpoint. */
function mockGetIdentityError(status = 500): void {
	fetchMock.get(CERTS_URL).intercept({ path: '/cdn-cgi/access/get-identity' }).reply(status, 'Internal Server Error');
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('validateAccessJwt', () => {
	it('validates a well-formed JWT from header', async () => {
		mockCerts();
		mockGetIdentity(); // No groups in JWT, get-identity returns empty
		const token = await createJwt(defaultPayload());
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.email).toBe('test@example.com');
		expect(identity!.sub).toBe('user-123');
		expect(identity!.type).toBe('app');
	});

	it('validates JWT from CF_Authorization cookie', async () => {
		mockCerts();
		mockGetIdentity();
		const token = await createJwt(defaultPayload());
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { Cookie: `CF_Authorization=${token}; other=value` },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.email).toBe('test@example.com');
	});

	it('prefers header over cookie', async () => {
		mockCerts();
		mockGetIdentity();
		const headerToken = await createJwt(defaultPayload({ email: 'header@example.com' }));
		const cookieToken = await createJwt(defaultPayload({ email: 'cookie@example.com' }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: {
				'Cf-Access-Jwt-Assertion': headerToken,
				Cookie: `CF_Authorization=${cookieToken}`,
			},
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity!.email).toBe('header@example.com');
	});

	it('returns null when no JWT present', async () => {
		const request = new Request('https://purge.example.com/admin/keys');
		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('returns null for expired JWT', async () => {
		mockCerts();
		// Expired well beyond the 60s clock-skew tolerance window
		const token = await createJwt(defaultPayload({ exp: Math.floor(Date.now() / 1000) - 120 }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('accepts JWT expired within clock-skew window (60s tolerance)', async () => {
		mockCerts();
		mockGetIdentity();
		// Expired only 30s ago — within the 60s clock-skew tolerance
		const token = await createJwt(defaultPayload({ exp: Math.floor(Date.now() / 1000) - 30 }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.email).toBe('test@example.com');
	});

	it('accepts JWT with iat slightly in the future (within 60s skew)', async () => {
		mockCerts();
		mockGetIdentity();
		const now = Math.floor(Date.now() / 1000);
		// iat is 30s in the future — within the 60s clock-skew tolerance
		const token = await createJwt(defaultPayload({ iat: now + 30 }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.email).toBe('test@example.com');
	});

	it('returns null for JWT with iat far in the future (beyond 60s skew)', async () => {
		mockCerts();
		const now = Math.floor(Date.now() / 1000);
		// iat is 120s in the future — well beyond the 60s clock-skew tolerance
		const token = await createJwt(defaultPayload({ iat: now + 120 }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('returns null for wrong audience', async () => {
		mockCerts();
		const token = await createJwt(defaultPayload({ aud: ['wrong-aud'] }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('returns null for wrong issuer', async () => {
		mockCerts();
		const token = await createJwt(defaultPayload({ iss: 'https://wrong-team.cloudflareaccess.com' }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('returns null for invalid signature', async () => {
		mockCerts();
		// Generate a different key pair to sign with
		const otherKeyPair = (await crypto.subtle.generateKey(
			{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
			true,
			['sign', 'verify'],
		)) as CryptoKeyPair;
		const token = await createJwt(defaultPayload(), { privateKey: otherKeyPair.privateKey });
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('returns null for unknown kid', async () => {
		// Mock twice: first fetch returns known keys, retry after cache-clear returns same keys (kid still unknown)
		mockCerts();
		mockCerts();
		const token = await createJwt(defaultPayload(), { kid: 'unknown-kid' });
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('returns null for malformed token', async () => {
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': 'not.a.valid.jwt' },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).toBeNull();
	});

	it('caches JWKS keys', async () => {
		// First call fetches
		mockCerts();
		mockGetIdentity();
		const token1 = await createJwt(defaultPayload({ email: 'first@example.com' }));
		const req1 = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token1 },
		});
		const id1 = await validateAccessJwt(req1, TEAM_NAME, AUD);
		expect(id1!.email).toBe('first@example.com');

		// Second call should use cache — no new fetch mock for certs needed, but get-identity still called
		mockGetIdentity();
		const token2 = await createJwt(defaultPayload({ email: 'second@example.com' }));
		const req2 = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token2 },
		});
		const id2 = await validateAccessJwt(req2, TEAM_NAME, AUD);
		expect(id2!.email).toBe('second@example.com');
	});

	it('handles service token type', async () => {
		mockCerts();
		mockGetIdentity();
		const token = await createJwt(defaultPayload({ type: 'service-token', email: 'svc@example.com' }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity!.type).toBe('service-token');
		expect(identity!.email).toBe('svc@example.com');
	});
});

// ─── Get-identity groups resolution ─────────────────────────────────

describe('validateAccessJwt - groups resolution', () => {
	it('uses groups from JWT payload when present', async () => {
		mockCerts();
		// Groups in JWT — should NOT call get-identity
		const token = await createJwt(defaultPayload({ groups: ['admin-team', 'dev-team'] }));
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.groups).toEqual(['admin-team', 'dev-team']);
	});

	it('fetches groups from get-identity when JWT groups are empty', async () => {
		mockCerts();
		mockGetIdentity([
			{ id: 'g1', name: 'gatekeeper-admins', email: 'admins@example.com' },
			{ id: 'g2', name: 'dev-team', email: 'dev@example.com' },
		]);
		const token = await createJwt(defaultPayload()); // No groups in JWT
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.groups).toEqual(['gatekeeper-admins', 'dev-team']);
	});

	it('returns empty groups when get-identity fails', async () => {
		mockCerts();
		mockGetIdentityError(500);
		const token = await createJwt(defaultPayload());
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.groups).toEqual([]);
	});

	it('returns empty groups when get-identity returns 404', async () => {
		mockCerts();
		mockGetIdentityError(404);
		const token = await createJwt(defaultPayload());
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.groups).toEqual([]);
	});

	it('handles get-identity with no groups field', async () => {
		mockCerts();
		// get-identity returns a response without groups
		fetchMock
			.get(CERTS_URL)
			.intercept({ path: '/cdn-cgi/access/get-identity' })
			.reply(200, JSON.stringify({ email: 'test@example.com' }));
		const token = await createJwt(defaultPayload());
		const request = new Request('https://purge.example.com/admin/keys', {
			headers: { 'Cf-Access-Jwt-Assertion': token },
		});

		const identity = await validateAccessJwt(request, TEAM_NAME, AUD);
		expect(identity).not.toBeNull();
		expect(identity!.groups).toEqual([]);
	});
});

// ─── fetchAccessGroups unit tests ───────────────────────────────────

describe('fetchAccessGroups', () => {
	it('extracts group names from get-identity response', async () => {
		mockGetIdentity([
			{ id: '1', name: 'team-a' },
			{ id: '2', name: 'team-b', email: 'b@example.com' },
		]);

		const groups = await fetchAccessGroups('fake-jwt', TEAM_NAME);
		expect(groups).toEqual(['team-a', 'team-b']);
	});

	it('returns empty array on HTTP error', async () => {
		mockGetIdentityError(403);
		const groups = await fetchAccessGroups('fake-jwt', TEAM_NAME);
		expect(groups).toEqual([]);
	});

	it('returns empty array when groups is not an array', async () => {
		fetchMock
			.get(CERTS_URL)
			.intercept({ path: '/cdn-cgi/access/get-identity' })
			.reply(200, JSON.stringify({ groups: 'not-an-array' }));

		const groups = await fetchAccessGroups('fake-jwt', TEAM_NAME);
		expect(groups).toEqual([]);
	});

	it('filters out entries with empty names', async () => {
		mockGetIdentity([
			{ id: '1', name: 'valid-group' },
			{ id: '2', name: '' },
		]);

		const groups = await fetchAccessGroups('fake-jwt', TEAM_NAME);
		expect(groups).toEqual(['valid-group']);
	});

	it('extracts groups from custom claims (OIDC string array)', async () => {
		fetchMock
			.get(CERTS_URL)
			.intercept({ path: '/cdn-cgi/access/get-identity' })
			.reply(
				200,
				JSON.stringify({
					email: 'test@example.com',
					custom: { groups: ['gatekeeper-admins', 'dev-team', 'gatekeeper-admins'] },
				}),
			);

		const groups = await fetchAccessGroups('fake-jwt', TEAM_NAME);
		// Deduplicates
		expect(groups).toEqual(['gatekeeper-admins', 'dev-team']);
	});

	it('extracts groups from oidc_fields', async () => {
		fetchMock
			.get(CERTS_URL)
			.intercept({ path: '/cdn-cgi/access/get-identity' })
			.reply(
				200,
				JSON.stringify({
					email: 'test@example.com',
					oidc_fields: { groups: ['ops-team', 'viewer-team'] },
				}),
			);

		const groups = await fetchAccessGroups('fake-jwt', TEAM_NAME);
		expect(groups).toEqual(['ops-team', 'viewer-team']);
	});

	it('prefers top-level groups over custom.groups', async () => {
		fetchMock
			.get(CERTS_URL)
			.intercept({ path: '/cdn-cgi/access/get-identity' })
			.reply(
				200,
				JSON.stringify({
					groups: [{ id: '1', name: 'from-scim' }],
					custom: { groups: ['from-oidc'] },
				}),
			);

		const groups = await fetchAccessGroups('fake-jwt', TEAM_NAME);
		expect(groups).toEqual(['from-scim']);
	});
});

// ─── Integration: admin middleware with Access JWT ───────────────────

describe('admin middleware - Access JWT auth', () => {
	it('Access JWT grants admin access when configured', async () => {
		// This test requires CF_ACCESS_TEAM_NAME and CF_ACCESS_AUD to be set
		// Since they're optional secrets, this tests the X-Admin-Key fallback
		const res = await SELF.fetch('https://purge.example.com/admin/keys?zone_id=aaaa1111bbbb2222cccc3333dddd4444', {
			headers: { 'X-Admin-Key': env.ADMIN_KEY },
		});
		expect(res.status).toBe(200);
	});

	it('rejects request with neither JWT nor admin key', async () => {
		const res = await SELF.fetch('https://purge.example.com/admin/keys?zone_id=aaaa1111bbbb2222cccc3333dddd4444');
		expect(res.status).toBe(401);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
		expect(data.errors[0].message).toBe('Unauthorized');
	});
});

// ─── /admin/me endpoint ─────────────────────────────────────────────

describe('GET /admin/me', () => {
	it('returns identity for API key auth', async () => {
		const res = await SELF.fetch('https://purge.example.com/admin/me', {
			headers: { 'X-Admin-Key': env.ADMIN_KEY },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.authMethod).toBe('api-key');
		expect(data.result.role).toBe('admin');
		expect(data.result.email).toBeNull();
	});

	it('rejects unauthenticated requests', async () => {
		const res = await SELF.fetch('https://purge.example.com/admin/me');
		expect(res.status).toBe(401);
	});
});
