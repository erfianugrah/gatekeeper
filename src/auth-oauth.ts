/**
 * Generic OAuth2 / OIDC client with PKCE.
 *
 * Works with any OIDC-compliant provider (Cloudflare Access for SaaS, Auth0,
 * Okta, Keycloak, Google, Entra ID, etc.). The Worker is the relying party.
 *
 * Uses PKCE (S256) for the authorization code flow via the `arctic` library.
 *
 * Flow:
 *   1. GET /auth/oauth/login      — generate state + code_verifier, redirect to IdP
 *   2. GET /auth/oauth/callback   — exchange code for tokens, decode ID token, create session
 *
 * Required env vars / secrets:
 *   OAUTH_CLIENT_ID          — OAuth2 client ID
 *   OAUTH_CLIENT_SECRET      — OAuth2 client secret (null-safe for public clients)
 *   OAUTH_AUTH_ENDPOINT      — Authorization endpoint URL
 *   OAUTH_TOKEN_ENDPOINT     — Token endpoint URL
 *
 * Optional env vars:
 *   OAUTH_SCOPES             — Space-separated scopes (default: "openid email profile groups")
 *   OAUTH_EMAIL_CLAIM        — ID token claim for email (default: "email")
 *   OAUTH_GROUPS_CLAIM       — ID token claim for groups (default: "groups")
 */

import { Hono } from 'hono';
import { OAuth2Client, generateState, generateCodeVerifier, CodeChallengeMethod, decodeIdToken } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import { getStub } from './do-stub';
import { resolveRole } from './auth-admin';
import { SessionManager } from './session-manager';
import type { HonoEnv, AdminRole } from './types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Cookie names for the PKCE state and code verifier (short-lived, HttpOnly). */
const STATE_COOKIE = 'gk_oauth_state';
const VERIFIER_COOKIE = 'gk_oauth_verifier';

/** Cookie max-age for OAuth state: 10 minutes. */
const OAUTH_COOKIE_MAX_AGE = 600;

const DEFAULT_SCOPES = 'openid email profile groups';
const DEFAULT_EMAIL_CLAIM = 'email';
const DEFAULT_GROUPS_CLAIM = 'groups';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Set a short-lived HttpOnly cookie for OAuth flow. */
function oauthCookie(name: string, value: string, secure: boolean): string {
	return `${name}=${value}; Path=/; Max-Age=${OAUTH_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Clear an OAuth cookie. */
function clearOauthCookie(name: string, secure: boolean): string {
	return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Extract a cookie value by name from a Request. */
function getCookie(req: Request, name: string): string | null {
	const header = req.headers.get('Cookie');
	if (!header) return null;
	for (const part of header.split(';')) {
		const [k, ...rest] = part.trim().split('=');
		if (k === name) return rest.join('=');
	}
	return null;
}

/** Check if the origin is HTTPS (affects Secure flag on cookies). */
function isSecure(req: Request): boolean {
	return new URL(req.url).protocol === 'https:';
}

/** Check that all required OAuth env vars are present. */
function oauthConfigured(env: Env): boolean {
	return !!(env.OAUTH_CLIENT_ID && env.OAUTH_AUTH_ENDPOINT && env.OAUTH_TOKEN_ENDPOINT);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const oauthApp = new Hono<HonoEnv>();

/**
 * Initiate OAuth login — redirect to the provider's authorization endpoint.
 * Generates PKCE code_verifier + state, stores in cookies.
 */
oauthApp.get('/login', (c) => {
	if (!oauthConfigured(c.env)) {
		return c.json({ success: false, errors: [{ code: 500, message: 'OAuth not configured' }] }, 500);
	}

	const origin = new URL(c.req.url).origin;
	const redirectUri = `${origin}/auth/oauth/callback`;

	const client = new OAuth2Client(c.env.OAUTH_CLIENT_ID!, c.env.OAUTH_CLIENT_SECRET ?? null, redirectUri);

	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const scopes = (c.env.OAUTH_SCOPES ?? DEFAULT_SCOPES).split(/\s+/).filter(Boolean);

	const url = client.createAuthorizationURLWithPKCE(c.env.OAUTH_AUTH_ENDPOINT!, state, CodeChallengeMethod.S256, codeVerifier, scopes);

	const secure = isSecure(c.req.raw);

	console.log(JSON.stringify({ breadcrumb: 'oauth-login-redirect', authEndpoint: c.env.OAUTH_AUTH_ENDPOINT }));

	return new Response(null, {
		status: 302,
		headers: [
			['Location', url.toString()],
			['Set-Cookie', oauthCookie(STATE_COOKIE, state, secure)],
			['Set-Cookie', oauthCookie(VERIFIER_COOKIE, codeVerifier, secure)],
		],
	});
});

/**
 * OAuth callback — exchange authorization code for tokens, create session.
 */
oauthApp.get('/callback', async (c) => {
	if (!oauthConfigured(c.env)) {
		return c.json({ success: false, errors: [{ code: 500, message: 'OAuth not configured' }] }, 500);
	}

	const reqUrl = new URL(c.req.url);
	const code = reqUrl.searchParams.get('code');
	const state = reqUrl.searchParams.get('state');
	const errorParam = reqUrl.searchParams.get('error');

	// Handle errors from the authorization server
	if (errorParam) {
		const errorDesc = reqUrl.searchParams.get('error_description') ?? errorParam;
		console.log(JSON.stringify({ breadcrumb: 'oauth-callback-error', error: errorParam, description: errorDesc }));
		return new Response(null, {
			status: 302,
			headers: { Location: `/login?error=${encodeURIComponent(errorDesc)}` },
		});
	}

	// Validate state
	const storedState = getCookie(c.req.raw, STATE_COOKIE);
	const storedVerifier = getCookie(c.req.raw, VERIFIER_COOKIE);

	if (!code || !state || !storedState || state !== storedState || !storedVerifier) {
		console.log(
			JSON.stringify({
				breadcrumb: 'oauth-callback-state-mismatch',
				hasCode: !!code,
				hasState: !!state,
				hasStoredState: !!storedState,
				stateMatch: state === storedState,
				hasVerifier: !!storedVerifier,
			}),
		);
		return new Response(null, {
			status: 302,
			headers: { Location: '/login?error=Invalid+OAuth+state.+Please+try+again.' },
		});
	}

	// Exchange authorization code for tokens
	const redirectUri = `${reqUrl.origin}/auth/oauth/callback`;
	const client = new OAuth2Client(c.env.OAUTH_CLIENT_ID!, c.env.OAUTH_CLIENT_SECRET ?? null, redirectUri);

	let tokens: OAuth2Tokens;
	try {
		tokens = await client.validateAuthorizationCode(c.env.OAUTH_TOKEN_ENDPOINT!, code, storedVerifier);
	} catch (e: any) {
		console.error(JSON.stringify({ breadcrumb: 'oauth-token-exchange-failed', error: e.message }));
		return new Response(null, {
			status: 302,
			headers: { Location: `/login?error=${encodeURIComponent('Token exchange failed. Please try again.')}` },
		});
	}

	// Decode the ID token to get user info.
	// idToken() throws if no id_token in the response (e.g. missing openid scope).
	// decodeIdToken() only decodes (base64) — no signature verification. This is
	// acceptable because the token comes from a direct HTTPS call to the token
	// endpoint, not via the browser. The TLS connection authenticates the IdP.
	let claims: Record<string, any>;
	try {
		const idToken = tokens.idToken();
		claims = decodeIdToken(idToken) as Record<string, any>;
	} catch (e: any) {
		console.error(JSON.stringify({ breadcrumb: 'oauth-id-token-missing', error: e.message }));
		return new Response(null, {
			status: 302,
			headers: { Location: `/login?error=${encodeURIComponent('No ID token in response. Ensure the "openid" scope is configured.')}` },
		});
	}

	const emailClaim = c.env.OAUTH_EMAIL_CLAIM ?? DEFAULT_EMAIL_CLAIM;
	const groupsClaim = c.env.OAUTH_GROUPS_CLAIM ?? DEFAULT_GROUPS_CLAIM;

	const email = typeof claims[emailClaim] === 'string' ? (claims[emailClaim] as string) : null;
	if (!email) {
		console.log(JSON.stringify({ breadcrumb: 'oauth-no-email', emailClaim, claimKeys: Object.keys(claims) }));
		return new Response(null, {
			status: 302,
			headers: { Location: `/login?error=${encodeURIComponent(`No "${emailClaim}" claim in ID token.`)}` },
		});
	}

	const rawGroups = claims[groupsClaim];
	const groups: string[] = Array.isArray(rawGroups) ? rawGroups : typeof rawGroups === 'string' ? [rawGroups] : [];

	// Resolve role: check built-in user first, then RBAC groups
	const stub = getStub(c.env);
	const builtInUser = await stub.getUserByEmail(email);

	let role: AdminRole | null;
	let userId: string;

	if (builtInUser) {
		role = builtInUser.role;
		userId = builtInUser.id;
		console.log(
			JSON.stringify({
				breadcrumb: 'oauth-login-merged',
				email,
				builtInUserId: builtInUser.id,
				role,
			}),
		);
	} else {
		role = resolveRole(groups, c.env, email);
		// Use the OIDC sub as a stable user ID for session tracking
		userId = typeof claims.sub === 'string' ? claims.sub : `oauth:${email}`;
		console.log(JSON.stringify({ breadcrumb: 'oauth-login-rbac', email, groups, role }));
	}

	if (!role) {
		console.log(JSON.stringify({ breadcrumb: 'oauth-rbac-denied', email, groups }));
		return new Response(null, {
			status: 302,
			headers: { Location: '/login?error=Insufficient+permissions.+No+matching+RBAC+group.' },
		});
	}

	// Create a session
	const session = await stub.createSession(userId, email, role);
	const maxAgeSec = Math.max(0, Math.floor((session.expires_at - Date.now()) / 1000));
	const sessionCookie = SessionManager.buildCookie(session.id, maxAgeSec);

	const secure = isSecure(c.req.raw);

	console.log(JSON.stringify({ breadcrumb: 'oauth-login-ok', email, role }));

	return new Response(null, {
		status: 302,
		headers: [
			['Location', '/dashboard/'],
			['Set-Cookie', sessionCookie],
			['Set-Cookie', clearOauthCookie(STATE_COOKIE, secure)],
			['Set-Cookie', clearOauthCookie(VERIFIER_COOKIE, secure)],
		],
	});
});
