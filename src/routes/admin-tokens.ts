/**
 * Admin API token management routes.
 *
 * Named, revocable, role-scoped tokens for the /admin management plane (the self-service
 * alternative to the shared ADMIN_KEY env secret). Admin-only.
 *   GET    /tokens       - list all admin tokens (metadata only)
 *   POST   /tokens       - mint a token; the value is returned exactly once
 *   DELETE /tokens/:id   - revoke a token
 *
 * The plaintext token is shown only in the POST response. It is never retrievable again.
 */

import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { emitAudit, resolveCreatedBy } from './admin-helpers';
import { jsonError } from './admin-schemas';
import type { HonoEnv, AdminRole } from '../types';

export const adminTokensApp = new Hono<HonoEnv>();

const VALID_ROLES: AdminRole[] = ['admin', 'operator', 'viewer'];

/** Max token lifetime accepted from a client: 365 days. */
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// ─── List tokens ──────────────────────────────────────────────────────────────

adminTokensApp.get('/', async (c) => {
	const stub = getStub(c.env);
	const tokens = await stub.listAdminTokens();
	return c.json({ success: true, result: tokens });
});

// ─── Create token ───────────────────────────────────────────────────────────

adminTokensApp.post('/', async (c) => {
	try {
		const body = await c.req.json<{ name?: string; role?: string; expires_in_days?: number; expires_at?: number }>();

		const name = typeof body.name === 'string' ? body.name.trim() : '';
		if (!name) {
			return jsonError(c, 400, 'Token name is required');
		}
		if (name.length > 100) {
			return jsonError(c, 400, 'Token name must be 100 characters or fewer');
		}

		const role = (body.role ?? 'admin') as AdminRole;
		if (!VALID_ROLES.includes(role)) {
			return jsonError(c, 400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
		}

		// Expiry: prefer an explicit unix-ms expires_at, else derive from expires_in_days.
		let expiresAt: number | null = null;
		if (typeof body.expires_at === 'number') {
			expiresAt = body.expires_at;
		} else if (typeof body.expires_in_days === 'number' && body.expires_in_days > 0) {
			expiresAt = Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000;
		}
		if (expiresAt !== null) {
			if (expiresAt <= Date.now()) {
				return jsonError(c, 400, 'expires_at must be in the future');
			}
			if (expiresAt > Date.now() + MAX_TTL_MS) {
				return jsonError(c, 400, 'Token lifetime cannot exceed 365 days');
			}
		}

		const createdBy = resolveCreatedBy(c.get('accessIdentity'), null);
		const stub = getStub(c.env);
		const { token, record } = await stub.createAdminToken({ name, role, createdBy, expiresAt });

		emitAudit(c, {
			entity_type: 'admin_token',
			entity_id: record.id,
			action: 'create_admin_token',
			detail: JSON.stringify({ name: record.name, role: record.role, expires_at: record.expires_at }),
		});

		// The `token` field is the ONLY time the plaintext value is returned.
		return c.json({ success: true, result: { ...record, token } }, 201);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'admin.createAdminToken', error: e.message }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Revoke token ─────────────────────────────────────────────────────────────

adminTokensApp.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const stub = getStub(c.env);
	const revoked = await stub.revokeAdminToken(id);

	if (!revoked) {
		return jsonError(c, 404, 'Admin token not found or already revoked');
	}

	emitAudit(c, {
		entity_type: 'admin_token',
		entity_id: id,
		action: 'revoke_admin_token',
		detail: null,
	});

	return c.json({ success: true, result: { id, revoked: true }, message: 'Admin token revoked.' });
});
