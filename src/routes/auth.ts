/**
 * Built-in authentication routes.
 *
 * Provides email/password login without Cloudflare Access.
 *   POST /auth/login    — verify credentials, create session, set cookie
 *   POST /auth/logout   — destroy session, clear cookie
 *   GET  /auth/session  — validate current session (for dashboard)
 *   POST /auth/bootstrap — create the first admin user (only works when no users exist)
 *
 * Login and bootstrap accept both application/json and application/x-www-form-urlencoded.
 * Form submissions redirect on success; JSON requests return JSON.
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

/** Check if the request is a form submission (vs JSON API call). */
function isFormSubmission(req: Request): boolean {
	const ct = req.headers.get('Content-Type') ?? '';
	return ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data');
}

/** Parse email + password from either JSON or form-encoded body. */
async function parseCredentials(c: any): Promise<{ email: string; password: string } | null> {
	if (isFormSubmission(c.req.raw)) {
		const form = await c.req.parseBody();
		const email = typeof form.email === 'string' ? form.email : '';
		const password = typeof form.password === 'string' ? form.password : '';
		if (!email || !password) return null;
		return { email, password };
	}
	try {
		const body = (await c.req.json()) as { email?: string; password?: string };
		if (!body.email || !body.password) return null;
		return { email: body.email, password: body.password };
	} catch {
		return null;
	}
}

/** Return a login-page redirect with an error message (for form submissions). */
function loginRedirectWithError(message: string): Response {
	return new Response(null, {
		status: 303,
		headers: { Location: `/login?error=${encodeURIComponent(message)}` },
	});
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const authApp = new Hono<HonoEnv>();

/**
 * Auth config — tells the login page which auth methods are available.
 * Public endpoint (no auth required).
 */
authApp.get('/config', async (c) => {
	const hasAccess = !!(c.env.CF_ACCESS_TEAM_NAME && c.env.CF_ACCESS_AUD);
	const stub = getStub(c.env);
	const userCount = await stub.countUsers();

	return c.json({
		success: true,
		result: {
			/** Whether Cloudflare Access SSO is configured. */
			access_enabled: hasAccess,
			/** The Access team domain — used to construct the SSO login URL. */
			access_domain: hasAccess ? `${c.env.CF_ACCESS_TEAM_NAME}.cloudflareaccess.com` : null,
			/** Whether the bootstrap flow is needed (no users exist). */
			bootstrap: userCount === 0,
		},
	});
});

/** Login — verify credentials and create a session. */
authApp.post('/login', async (c) => {
	const form = isFormSubmission(c.req.raw);
	try {
		const creds = await parseCredentials(c);
		if (!creds) {
			if (form) return loginRedirectWithError('Email and password are required');
			return c.json({ success: false, errors: [{ code: 400, message: 'Email and password are required' }] }, 400);
		}

		const stub = getStub(c.env);
		const user = await stub.verifyCredentials(creds.email, creds.password);

		if (!user) {
			console.log(JSON.stringify({ breadcrumb: 'auth-login-failed', email: creds.email }));
			if (form) return loginRedirectWithError('Invalid email or password');
			return c.json({ success: false, errors: [{ code: 401, message: 'Invalid email or password' }] }, 401);
		}

		// Create session
		const session = await stub.createSession(user.id, user.email, user.role);
		const maxAgeSec = Math.floor((session.expires_at - Date.now()) / 1000);
		const cookie = SessionManager.buildCookie(session.id, maxAgeSec);

		console.log(JSON.stringify({ breadcrumb: 'auth-login-ok', email: user.email, role: user.role }));

		if (form) {
			return new Response(null, {
				status: 303,
				headers: { Location: '/dashboard/', 'Set-Cookie': cookie },
			});
		}

		return c.json({ success: true, result: { email: user.email, role: user.role } }, 200, { 'Set-Cookie': cookie });
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'auth.login', error: e.message }));
		if (form) return loginRedirectWithError('Internal server error');
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

		if (isFormSubmission(c.req.raw)) {
			return new Response(null, {
				status: 303,
				headers: { Location: '/login', 'Set-Cookie': SessionManager.clearCookie() },
			});
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
	const form = isFormSubmission(c.req.raw);
	try {
		const stub = getStub(c.env);
		const count = await stub.countUsers();

		if (count > 0) {
			if (form) return loginRedirectWithError('Bootstrap is disabled — users already exist');
			return c.json({ success: false, errors: [{ code: 403, message: 'Bootstrap is disabled — users already exist' }] }, 403);
		}

		const creds = await parseCredentials(c);
		if (!creds) {
			if (form) return loginRedirectWithError('Email and password are required');
			return c.json({ success: false, errors: [{ code: 400, message: 'Email and password are required' }] }, 400);
		}

		if (creds.password.length < 12) {
			if (form) return loginRedirectWithError('Password must be at least 12 characters');
			return c.json({ success: false, errors: [{ code: 400, message: 'Password must be at least 12 characters' }] }, 400);
		}

		const user = await stub.createUser({ email: creds.email, password: creds.password, role: 'admin' });

		console.log(JSON.stringify({ breadcrumb: 'auth-bootstrap', email: user.email }));

		// Auto-login: create a session for the new user
		const session = await stub.createSession(user.id, user.email, user.role);
		const maxAgeSec = Math.floor((session.expires_at - Date.now()) / 1000);
		const cookie = SessionManager.buildCookie(session.id, maxAgeSec);

		if (form) {
			return new Response(null, {
				status: 303,
				headers: { Location: '/dashboard/', 'Set-Cookie': cookie },
			});
		}

		return c.json(
			{ success: true, result: { email: user.email, role: user.role }, message: 'First admin user created. You are now logged in.' },
			201,
			{ 'Set-Cookie': cookie },
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'auth.bootstrap', error: e.message }));
		if (form) return loginRedirectWithError(e.message);
		return c.json({ success: false, errors: [{ code: 500, message: e.message }] }, 500);
	}
});
