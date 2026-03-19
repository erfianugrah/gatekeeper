/**
 * Admin authentication + RBAC middleware.
 *
 * Three auth paths (checked in order):
 * 1. Cloudflare Access JWT (dashboard SSO) — provides identity + RBAC from IdP groups
 * 2. X-Admin-Key header (CLI / automation) — always "admin" role
 * 3. Session cookie (built-in auth) — provides identity + role from the user record
 *
 * Access JWT is checked first so dashboard users get identity attached to tokens.
 * CF Access is only enforced at the edge on /dashboard/*, but the CF_Authorization
 * cookie is sent on /admin/* calls from the SPA, so the worker can read it here.
 *
 * RBAC is opt-in: when RBAC_*_GROUPS env vars are set, roles are resolved from JWT groups.
 * When unset, all authenticated users get the "admin" role (backward compatible).
 */

import type { Context, Next } from 'hono';
import { validateAccessJwt } from './auth-access';
import { timingSafeEqual } from './crypto';
import { getStub } from './do-stub';
import { ADMIN_KEY_HEADER } from './constants';
import { SESSION_COOKIE } from './session-manager';
import type { HonoEnv, AdminRole } from './types';

// ─── Role hierarchy ─────────────────────────────────────────────────────────

const ROLE_LEVELS: Record<AdminRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** Parse comma-separated values from an env var. Returns empty array if unset. */
function parseList(envVar?: string): string[] {
	if (!envVar) return [];
	return envVar
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

/** Check if an email matches a list of emails or domains (case-insensitive). */
function emailMatchesList(email: string, emails: string[], domains: string[]): boolean {
	const lower = email.toLowerCase();
	if (emails.some((e) => lower === e.toLowerCase())) return true;
	const atIdx = lower.lastIndexOf('@');
	const domain = atIdx >= 0 ? lower.slice(atIdx + 1) : null;
	if (domain && domains.some((d) => domain === d.toLowerCase())) return true;
	return false;
}

/**
 * Resolve the highest role from the user's groups, email, or domain.
 *
 * Checks (in priority order):
 *   1. Email match  — RBAC_ADMIN_EMAILS / RBAC_OPERATOR_EMAILS / RBAC_VIEWER_EMAILS
 *   2. Domain match — RBAC_ADMIN_DOMAINS / RBAC_OPERATOR_DOMAINS / RBAC_VIEWER_DOMAINS
 *   3. IdP group    — RBAC_ADMIN_GROUPS / RBAC_OPERATOR_GROUPS / RBAC_VIEWER_GROUPS
 *
 * Returns null if RBAC is enabled but the user has no match.
 * Returns 'admin' if no RBAC env vars are set (backward compatible).
 */
export function resolveRole(groups: string[], env: Env, email?: string): AdminRole | null {
	const adminGroups = parseList(env.RBAC_ADMIN_GROUPS);
	const operatorGroups = parseList(env.RBAC_OPERATOR_GROUPS);
	const viewerGroups = parseList(env.RBAC_VIEWER_GROUPS);
	const adminEmails = parseList(env.RBAC_ADMIN_EMAILS);
	const operatorEmails = parseList(env.RBAC_OPERATOR_EMAILS);
	const viewerEmails = parseList(env.RBAC_VIEWER_EMAILS);
	const adminDomains = parseList(env.RBAC_ADMIN_DOMAINS);
	const operatorDomains = parseList(env.RBAC_OPERATOR_DOMAINS);
	const viewerDomains = parseList(env.RBAC_VIEWER_DOMAINS);

	const rbacEnabled =
		adminGroups.length > 0 ||
		operatorGroups.length > 0 ||
		viewerGroups.length > 0 ||
		adminEmails.length > 0 ||
		operatorEmails.length > 0 ||
		viewerEmails.length > 0 ||
		adminDomains.length > 0 ||
		operatorDomains.length > 0 ||
		viewerDomains.length > 0;

	// If no RBAC env vars are set, all authenticated users get admin (backward compatible)
	if (!rbacEnabled) return 'admin';

	// 1. Check email + domain (highest priority — works without IdP groups)
	if (email) {
		if (emailMatchesList(email, adminEmails, adminDomains)) return 'admin';
		if (emailMatchesList(email, operatorEmails, operatorDomains)) return 'operator';
		if (emailMatchesList(email, viewerEmails, viewerDomains)) return 'viewer';
	}

	// 2. Check IdP groups (case-insensitive)
	if (groups.length > 0) {
		const lowerGroups = groups.map((g) => g.toLowerCase());
		if (adminGroups.some((ag) => lowerGroups.includes(ag.toLowerCase()))) return 'admin';
		if (operatorGroups.some((og) => lowerGroups.includes(og.toLowerCase()))) return 'operator';
		if (viewerGroups.some((vg) => lowerGroups.includes(vg.toLowerCase()))) return 'viewer';
	}

	// RBAC enabled but user has no match — deny access
	return null;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/** Hono middleware that gates admin routes with Access JWT or X-Admin-Key. */
export async function adminAuth(c: Context<HonoEnv>, next: Next): Promise<Response | void> {
	// 1. Try Cloudflare Access JWT — provides identity for dashboard SSO users
	if (c.env.CF_ACCESS_TEAM_NAME && c.env.CF_ACCESS_AUD) {
		const identity = await validateAccessJwt(c.req.raw, c.env.CF_ACCESS_TEAM_NAME, c.env.CF_ACCESS_AUD);
		if (identity) {
			// Check if a built-in user record exists for this email — if so, use its role
			// instead of RBAC group resolution. This merges Access SSO identity with
			// locally-managed user records so the role is always consistent.
			const stub = getStub(c.env);
			const builtInUser = identity.email ? await stub.getUserByEmail(identity.email) : null;

			let role: AdminRole | null;
			if (builtInUser) {
				role = builtInUser.role;
				console.log(
					JSON.stringify({
						breadcrumb: 'admin-auth-access-merged',
						email: identity.email,
						builtInUserId: builtInUser.id,
						role,
						method: c.req.method,
						path: c.req.path,
					}),
				);
			} else {
				role = resolveRole(identity.groups, c.env, identity.email);
				console.log(
					JSON.stringify({
						breadcrumb: 'admin-auth-access',
						email: identity.email,
						groups: identity.groups,
						role,
						method: c.req.method,
						path: c.req.path,
					}),
				);
			}

			if (!role) {
				console.log(
					JSON.stringify({
						breadcrumb: 'admin-auth-rbac-denied',
						email: identity.email,
						groups: identity.groups,
						rbacAdmin: c.env.RBAC_ADMIN_GROUPS,
						rbacOperator: c.env.RBAC_OPERATOR_GROUPS,
						rbacViewer: c.env.RBAC_VIEWER_GROUPS,
					}),
				);
				return c.json({ success: false, errors: [{ code: 403, message: 'Insufficient permissions — no matching RBAC group' }] }, 403);
			}
			c.set('accessIdentity', identity);
			c.set('adminRole', role);
			await next();
			return;
		}
	}

	// 2. Fall back to X-Admin-Key — for CLI and automation (always admin role)
	// Completely disable this auth path if ADMIN_KEY is unset or too short — prevents
	// empty-secret bypass and forces the operator to configure a real key.
	const configuredKey = c.env.ADMIN_KEY;
	const adminKey = c.req.header(ADMIN_KEY_HEADER);
	if (configuredKey && configuredKey.length >= 16 && adminKey && (await timingSafeEqual(adminKey, configuredKey))) {
		console.log(JSON.stringify({ breadcrumb: 'admin-auth-key', method: c.req.method, path: c.req.path }));
		c.set('adminRole', 'admin');
		await next();
		return;
	}

	// 3. Try session cookie — built-in email/password auth
	const sessionId = getSessionCookie(c.req.raw);
	if (sessionId) {
		const stub = getStub(c.env);
		const session = await stub.validateSession(sessionId);
		if (session) {
			console.log(
				JSON.stringify({
					breadcrumb: 'admin-auth-session',
					email: session.email,
					role: session.role,
					method: c.req.method,
					path: c.req.path,
				}),
			);
			c.set('accessIdentity', { email: session.email, groups: [], sub: session.user_id, type: 'session' } as any);
			c.set('adminRole', session.role);
			await next();
			return;
		}
	}

	console.log(JSON.stringify({ breadcrumb: 'admin-auth-rejected', method: c.req.method, path: c.req.path }));
	return c.json({ success: false, errors: [{ code: 401, message: 'Unauthorized' }] }, 401);
}

/** Extract session token from the gk_session cookie. */
function getSessionCookie(req: Request): string | null {
	const cookieHeader = req.headers.get('Cookie');
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name === SESSION_COOKIE) return rest.join('=');
	}
	return null;
}

/**
 * Create Hono middleware that requires a minimum admin role.
 * Must be used after `adminAuth` — reads `adminRole` from context.
 */
export function requireRole(minRole: AdminRole) {
	const minLevel = ROLE_LEVELS[minRole];

	return async (c: Context<HonoEnv>, next: Next): Promise<Response | void> => {
		const role = c.get('adminRole');
		if (!role) {
			// adminAuth middleware was not applied or did not set a role — fail closed
			return c.json({ success: false, errors: [{ code: 403, message: 'Forbidden — no role resolved' }] }, 403);
		}
		const level = ROLE_LEVELS[role];

		if (level < minLevel) {
			console.log(
				JSON.stringify({
					breadcrumb: 'rbac-denied',
					required: minRole,
					actual: role,
					method: c.req.method,
					path: c.req.path,
				}),
			);
			return c.json({ success: false, errors: [{ code: 403, message: `Forbidden — requires ${minRole} role, you have ${role}` }] }, 403);
		}

		await next();
	};
}

/**
 * Create Hono middleware with different role requirements for reads vs writes.
 * GET/HEAD use `readRole`; POST/PUT/DELETE use `writeRole`.
 */
export function requireRoleByMethod(readRole: AdminRole, writeRole: AdminRole) {
	const readLevel = ROLE_LEVELS[readRole];
	const writeLevel = ROLE_LEVELS[writeRole];

	return async (c: Context<HonoEnv>, next: Next): Promise<Response | void> => {
		const role = c.get('adminRole');
		if (!role) {
			return c.json({ success: false, errors: [{ code: 403, message: 'Forbidden — no role resolved' }] }, 403);
		}
		const level = ROLE_LEVELS[role];
		const isWrite = c.req.method !== 'GET' && c.req.method !== 'HEAD';
		const requiredLevel = isWrite ? writeLevel : readLevel;
		const requiredRole = isWrite ? writeRole : readRole;

		if (level < requiredLevel) {
			console.log(
				JSON.stringify({
					breadcrumb: 'rbac-denied',
					required: requiredRole,
					actual: role,
					method: c.req.method,
					path: c.req.path,
				}),
			);
			return c.json(
				{ success: false, errors: [{ code: 403, message: `Forbidden — requires ${requiredRole} role, you have ${role}` }] },
				403,
			);
		}

		await next();
	};
}
