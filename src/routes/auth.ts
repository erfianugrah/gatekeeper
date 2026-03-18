/**
 * Built-in authentication routes.
 *
 * Provides email/password login without Cloudflare Access.
 *   POST /auth/login    — verify credentials, create session, set cookie
 *   POST /auth/logout   — destroy session, clear cookie
 *   GET  /auth/session  — validate current session (for dashboard)
 *   POST /auth/bootstrap — create the first admin user (only works when no users exist)
 *
 * The login page is served at GET /login (see index.ts).
 */

import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { SessionManager, SESSION_COOKIE } from '../session-manager';
import type { HonoEnv } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Routes ─────────────────────────────────────────────────────────────────

export const authApp = new Hono<HonoEnv>();

/** Login — verify credentials and create a session. */
authApp.post('/login', async (c) => {
	try {
		const body = await c.req.json<{ email?: string; password?: string }>();
		if (!body.email || !body.password) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Email and password are required' }] }, 400);
		}

		const stub = getStub(c.env);
		const user = await stub.verifyCredentials(body.email, body.password);

		if (!user) {
			console.log(JSON.stringify({ breadcrumb: 'auth-login-failed', email: body.email }));
			return c.json({ success: false, errors: [{ code: 401, message: 'Invalid email or password' }] }, 401);
		}

		// Create session
		const session = await stub.createSession(user.id, user.email, user.role);
		const maxAgeSec = Math.floor((session.expires_at - Date.now()) / 1000);

		console.log(JSON.stringify({ breadcrumb: 'auth-login-ok', email: user.email, role: user.role }));

		return c.json(
			{
				success: true,
				result: { email: user.email, role: user.role },
			},
			200,
			{ 'Set-Cookie': SessionManager.buildCookie(session.id, maxAgeSec) },
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'auth.login', error: e.message }));
		return c.json({ success: false, errors: [{ code: 500, message: 'Internal server error' }] }, 500);
	}
});

/** Logout — destroy session and clear cookie. */
authApp.post('/logout', async (c) => {
	try {
		const sessionId = getSessionCookie(c.req.raw);
		if (sessionId) {
			const stub = getStub(c.env);
			await stub.deleteSession(sessionId);
		}

		return c.json({ success: true }, 200, { 'Set-Cookie': SessionManager.clearCookie() });
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'auth.logout', error: e.message }));
		return c.json({ success: false, errors: [{ code: 500, message: 'Internal server error' }] }, 500);
	}
});

/** Session check — validate current session cookie. Used by the dashboard. */
authApp.get('/session', async (c) => {
	const sessionId = getSessionCookie(c.req.raw);
	if (!sessionId) {
		return c.json({ success: false, errors: [{ code: 401, message: 'No session' }] }, 401);
	}

	const stub = getStub(c.env);
	const session = await stub.validateSession(sessionId);
	if (!session) {
		return c.json({ success: false, errors: [{ code: 401, message: 'Invalid or expired session' }] }, 401, {
			'Set-Cookie': SessionManager.clearCookie(),
		});
	}

	return c.json({
		success: true,
		result: { email: session.email, role: session.role, expires_at: session.expires_at },
	});
});

/**
 * Bootstrap — create the first admin user.
 * Only works when zero users exist in the database.
 * After the first user is created, this endpoint returns 403.
 */
authApp.post('/bootstrap', async (c) => {
	try {
		const stub = getStub(c.env);
		const count = await stub.countUsers();

		if (count > 0) {
			return c.json({ success: false, errors: [{ code: 403, message: 'Bootstrap is disabled — users already exist' }] }, 403);
		}

		const body = await c.req.json<{ email?: string; password?: string }>();
		if (!body.email || !body.password) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Email and password are required' }] }, 400);
		}

		if (body.password.length < 12) {
			return c.json({ success: false, errors: [{ code: 400, message: 'Password must be at least 12 characters' }] }, 400);
		}

		const user = await stub.createUser({ email: body.email, password: body.password, role: 'admin' });

		console.log(JSON.stringify({ breadcrumb: 'auth-bootstrap', email: user.email }));

		// Auto-login: create a session for the new user
		const session = await stub.createSession(user.id, user.email, user.role);
		const maxAgeSec = Math.floor((session.expires_at - Date.now()) / 1000);

		return c.json(
			{
				success: true,
				result: { email: user.email, role: user.role },
				message: 'First admin user created. You are now logged in.',
			},
			201,
			{ 'Set-Cookie': SessionManager.buildCookie(session.id, maxAgeSec) },
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'auth.bootstrap', error: e.message }));
		return c.json({ success: false, errors: [{ code: 500, message: e.message }] }, 500);
	}
});
