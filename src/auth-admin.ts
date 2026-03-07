/**
 * Admin authentication + RBAC middleware.
 *
 * Two auth paths:
 * 1. Cloudflare Access JWT (dashboard SSO) — provides admin access + identity + RBAC
 * 2. X-Admin-Key header (CLI / automation) — provides admin access, always "admin" role
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
import type { HonoEnv, AdminRole } from './types';

// ─── Role hierarchy ─────────────────────────────────────────────────────────

const ROLE_LEVELS: Record<AdminRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** Parse comma-separated group names from an env var. Returns empty array if unset. */
function parseGroups(envVar?: string): string[] {
	if (!envVar) return [];
	return envVar
		.split(',')
		.map((g) => g.trim())
		.filter(Boolean);
}

/**
 * Resolve the highest role from the user's groups.
 * Returns null if RBAC is enabled but the user has no matching group.
 * Returns 'admin' if RBAC is not configured (backward compatible).
 */
export function resolveRole(groups: string[], env: Env): AdminRole | null {
	const adminGroups = parseGroups(env.RBAC_ADMIN_GROUPS);
	const operatorGroups = parseGroups(env.RBAC_OPERATOR_GROUPS);
	const viewerGroups = parseGroups(env.RBAC_VIEWER_GROUPS);

	const rbacEnabled = adminGroups.length > 0 || operatorGroups.length > 0 || viewerGroups.length > 0;

	// If no RBAC env vars are set, all authenticated users get admin (backward compatible)
	if (!rbacEnabled) return 'admin';

	// Resolve highest matching role
	if (groups.some((g) => adminGroups.includes(g))) return 'admin';
	if (groups.some((g) => operatorGroups.includes(g))) return 'operator';
	if (groups.some((g) => viewerGroups.includes(g))) return 'viewer';

	// RBAC enabled but user has no matching group — deny access
	return null;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/** Hono middleware that gates admin routes with Access JWT or X-Admin-Key. */
export async function adminAuth(c: Context<HonoEnv>, next: Next): Promise<Response | void> {
	// 1. Try Cloudflare Access JWT — provides identity for dashboard SSO users
	if (c.env.CF_ACCESS_TEAM_NAME && c.env.CF_ACCESS_AUD) {
		const identity = await validateAccessJwt(c.req.raw, c.env.CF_ACCESS_TEAM_NAME, c.env.CF_ACCESS_AUD);
		if (identity) {
			const role = resolveRole(identity.groups, c.env);
			if (!role) {
				return c.json({ success: false, errors: [{ code: 403, message: 'Insufficient permissions — no matching RBAC group' }] }, 403);
			}
			c.set('accessIdentity', identity);
			c.set('adminRole', role);
			await next();
			return;
		}
	}

	// 2. Fall back to X-Admin-Key — for CLI and automation (always admin role)
	const adminKey = c.req.header('X-Admin-Key');
	if (adminKey && (await timingSafeEqual(adminKey, c.env.ADMIN_KEY))) {
		c.set('adminRole', 'admin');
		await next();
		return;
	}

	return c.json({ success: false, errors: [{ code: 401, message: 'Unauthorized' }] }, 401);
}

/**
 * Create Hono middleware that requires a minimum admin role.
 * Must be used after `adminAuth` — reads `adminRole` from context.
 */
export function requireRole(minRole: AdminRole) {
	const minLevel = ROLE_LEVELS[minRole];

	return async (c: Context<HonoEnv>, next: Next): Promise<Response | void> => {
		const role = c.get('adminRole') ?? 'viewer';
		const level = ROLE_LEVELS[role];

		if (level < minLevel) {
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
		const role = c.get('adminRole') ?? 'viewer';
		const level = ROLE_LEVELS[role];
		const isWrite = c.req.method !== 'GET' && c.req.method !== 'HEAD';
		const requiredLevel = isWrite ? writeLevel : readLevel;
		const requiredRole = isWrite ? writeRole : readRole;

		if (level < requiredLevel) {
			return c.json(
				{ success: false, errors: [{ code: 403, message: `Forbidden — requires ${requiredRole} role, you have ${role}` }] },
				403,
			);
		}

		await next();
	};
}
