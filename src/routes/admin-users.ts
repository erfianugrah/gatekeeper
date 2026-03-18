/**
 * Admin user management routes.
 *
 * CRUD for built-in auth users. Only available to admins.
 *   GET    /users       — list all users
 *   POST   /users       — create a user
 *   GET    /users/:id   — get a user
 *   PATCH  /users/:id   — update user role
 *   DELETE /users/:id   — delete a user
 *   POST   /users/:id/password — change a user's password
 */

import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { emitAudit } from './admin-helpers';
import type { HonoEnv, AdminRole } from '../types';

export const adminUsersApp = new Hono<HonoEnv>();

const VALID_ROLES: AdminRole[] = ['admin', 'operator', 'viewer'];

// ─── List users ─────────────────────────────────────────────────────────────

adminUsersApp.get('/', async (c) => {
	const stub = getStub(c.env);
	const users = await stub.listUsers();
	return c.json({ success: true, result: users });
});

// ─── Create user ────────────────────────────────────────────────────────────

adminUsersApp.post('/', async (c) => {
	try {
		const body = await c.req.json<{ email?: string; password?: string; role?: string }>();

		if (!body.email || !body.password) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Email and password are required' }] }, 400);
		}

		if (body.password.length < 12) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Password must be at least 12 characters' }] }, 400);
		}

		const role = (body.role ?? 'viewer') as AdminRole;
		if (!VALID_ROLES.includes(role)) {
			return c.json({ success: false, errors: [{ code: 400, message: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` }] }, 400);
		}

		const stub = getStub(c.env);
		const user = await stub.createUser({ email: body.email, password: body.password, role });

		emitAudit(c, {
			entity_type: 'user',
			entity_id: user.id,
			action: 'create_user',
			detail: JSON.stringify({ email: user.email, role: user.role }),
		});

		return c.json({ success: true, result: user }, 201);
	} catch (e: any) {
		if (e.message?.includes('already exists')) {
			return c.json({ success: false, errors: [{ code: 409, message: e.message }] }, 409);
		}
		console.error(JSON.stringify({ route: 'admin.createUser', error: e.message }));
		return c.json({ success: false, errors: [{ code: 500, message: 'Internal server error' }] }, 500);
	}
});

// ─── Get user ───────────────────────────────────────────────────────────────

adminUsersApp.get('/:id', async (c) => {
	const stub = getStub(c.env);
	const user = await stub.getUser(c.req.param('id'));

	if (!user) {
		return c.json({ success: false, errors: [{ code: 404, message: 'User not found' }] }, 404);
	}

	return c.json({ success: true, result: user });
});

// ─── Update user role ───────────────────────────────────────────────────────

adminUsersApp.patch('/:id', async (c) => {
	try {
		const body = await c.req.json<{ role?: string }>();

		if (!body.role) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Role is required' }] }, 400);
		}

		const role = body.role as AdminRole;
		if (!VALID_ROLES.includes(role)) {
			return c.json({ success: false, errors: [{ code: 400, message: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` }] }, 400);
		}

		const stub = getStub(c.env);
		const user = await stub.updateUserRole(c.req.param('id'), role);

		if (!user) {
			return c.json({ success: false, errors: [{ code: 404, message: 'User not found' }] }, 404);
		}

		emitAudit(c, {
			entity_type: 'user',
			entity_id: user.id,
			action: 'update_user_role',
			detail: JSON.stringify({ email: user.email, newRole: user.role }),
		});

		return c.json({ success: true, result: user });
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'admin.updateUser', error: e.message }));
		return c.json({ success: false, errors: [{ code: 500, message: 'Internal server error' }] }, 500);
	}
});

// ─── Change password ────────────────────────────────────────────────────────

adminUsersApp.post('/:id/password', async (c) => {
	try {
		const body = await c.req.json<{ password?: string }>();

		if (!body.password) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Password is required' }] }, 400);
		}

		if (body.password.length < 12) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Password must be at least 12 characters' }] }, 400);
		}

		const stub = getStub(c.env);
		const result = await stub.updateUserPassword(c.req.param('id'), body.password);

		if (!result) {
			return c.json({ success: false, errors: [{ code: 404, message: 'User not found' }] }, 404);
		}

		emitAudit(c, {
			entity_type: 'user',
			entity_id: c.req.param('id'),
			action: 'change_password',
			detail: null,
		});

		return c.json({ success: true, message: 'Password updated. All sessions for this user have been revoked.' });
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'admin.changePassword', error: e.message }));
		return c.json({ success: false, errors: [{ code: 500, message: 'Internal server error' }] }, 500);
	}
});

// ─── Delete user ────────────────────────────────────────────────────────────

adminUsersApp.delete('/:id', async (c) => {
	const stub = getStub(c.env);
	const deleted = await stub.deleteUser(c.req.param('id'));

	if (!deleted) {
		return c.json({ success: false, errors: [{ code: 404, message: 'User not found' }] }, 404);
	}

	emitAudit(c, {
		entity_type: 'user',
		entity_id: c.req.param('id'),
		action: 'delete_user',
		detail: null,
	});

	return c.json({ success: true, message: 'User deleted. All sessions have been revoked.' });
});
