import { Hono } from 'hono';
import { purgeRoute, __testClearInflightCache } from './routes/purge';
import { adminApp } from './routes/admin';
import { s3App } from './s3/routes';
import { deleteOldEvents } from './analytics';
import { deleteOldS3Events } from './s3/analytics';
import { deleteOldDnsEvents } from './cf/dns/analytics';
import { deleteOldCfProxyEvents } from './cf/analytics';
import { deleteOldAuditEvents } from './audit-log';
import { cfApp } from './cf/router';
import { authApp } from './routes/auth';
import { oauthApp } from './auth-oauth';
import { getStub } from './do-stub';
import { SESSION_COOKIE, SessionManager } from './session-manager';
import type { HonoEnv } from './types';

// Re-export DO class — wrangler requires it from the main entrypoint
export { Gatekeeper } from './durable-object';

// Re-export for tests
export { __testClearInflightCache };

// ─── Security headers ───────────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), document-domain=()',
	'Content-Security-Policy':
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();

/** Attach security headers to every Worker-generated response. */
app.use('*', async (c, next) => {
	await next();
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		// Don't overwrite CSP if the route explicitly set one (e.g. /logout needs a relaxed policy)
		if (name === 'Content-Security-Policy' && c.res.headers.has('Content-Security-Policy')) continue;
		c.header(name, value);
	}
});

app.get('/health', (c) => c.json({ ok: true }));

// ─── Auth routes ────────────────────────────────────────────────────────────
// OAuth routes must be mounted before the general /auth routes so that
// /auth/oauth/* is matched by the more specific prefix first.

app.route('/auth/oauth', oauthApp);
app.route('/auth', authApp);

// ─── Logout ─────────────────────────────────────────────────────────────────
// Destroys the gk_session server-side, clears the cookie, redirects to /login.

app.get('/logout', async (c) => {
	// Destroy the server-side session (best-effort)
	const cookieHeader = c.req.raw.headers.get('Cookie');
	if (cookieHeader) {
		for (const part of cookieHeader.split(';')) {
			const [name, ...rest] = part.trim().split('=');
			if (name === SESSION_COOKIE) {
				const sessionId = rest.join('=');
				if (sessionId) {
					try {
						const stub = getStub(c.env);
						await stub.deleteSession(sessionId);
					} catch {
						// Don't block logout on DO errors
					}
				}
				break;
			}
		}
	}

	console.log(JSON.stringify({ breadcrumb: 'logout' }));

	return new Response(null, {
		status: 302,
		headers: [
			['Location', '/login'],
			['Set-Cookie', SessionManager.clearCookie()],
			['Cache-Control', 'no-store'],
		],
	});
});

app.route('/', purgeRoute);
app.route('/admin', adminApp);
app.route('/s3', s3App);
app.route('/cf', cfApp);

// Backward compatibility: /v1/zones/:zoneId/dns_records/* -> /cf/zones/:zoneId/dns_records/*
// Old DNS clients hit /v1/zones/:zoneId/dns_records/...; the new canonical path is /cf/zones/:zoneId/dns_records/...
// Both paths are served by the same CF proxy router so behaviour is identical.
app.all('/v1/zones/:zoneId/dns_records/*', (c) => {
	const zoneId = c.req.param('zoneId');
	const rest = c.req.path.replace(`/v1/zones/${zoneId}/dns_records`, '/dns_records');
	const url = new URL(c.req.url);
	url.pathname = `/cf/zones/${zoneId}${rest}`;
	const newReq = new Request(url.toString(), c.req.raw);
	return app.fetch(newReq, c.env, c.executionCtx);
});
app.all('/v1/zones/:zoneId/dns_records', (c) => {
	const zoneId = c.req.param('zoneId');
	const url = new URL(c.req.url);
	url.pathname = `/cf/zones/${zoneId}/dns_records`;
	const newReq = new Request(url.toString(), c.req.raw);
	return app.fetch(newReq, c.env, c.executionCtx);
});

// ─── Exports ────────────────────────────────────────────────────────────────

export default {
	fetch: app.fetch,

	/** Cron-triggered retention + cleanup job. */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		try {
			const stub = getStub(env);
			const gwConfig = await stub.getConfig();
			const retentionDays = gwConfig.retention_days;

			// Phase 1: Delete old analytics/audit events from D1
			const [purgeDeleted, s3Deleted, dnsDeleted, cfProxyDeleted, auditDeleted] = await Promise.all([
				deleteOldEvents(env.ANALYTICS_DB, retentionDays),
				deleteOldS3Events(env.ANALYTICS_DB, retentionDays),
				deleteOldDnsEvents(env.ANALYTICS_DB, retentionDays),
				deleteOldCfProxyEvents(env.ANALYTICS_DB, retentionDays),
				deleteOldAuditEvents(env.ANALYTICS_DB, retentionDays),
			]);

			// Phase 2: Revoke expired keys/credentials, delete expired upstream tokens/R2 endpoints
			const cleanup = await stub.cleanupExpired();

			console.log(
				JSON.stringify({
					event: 'retention_cron',
					cron: controller.cron,
					retentionDays,
					purgeDeleted,
					s3Deleted,
					dnsDeleted,
					cfProxyDeleted,
					auditDeleted,
					...cleanup,
					ts: new Date(controller.scheduledTime).toISOString(),
				}),
			);
		} catch (e: any) {
			console.error(
				JSON.stringify({
					event: 'retention_cron_error',
					cron: controller.cron,
					error: e.message,
				}),
			);
			throw e;
		}
	},
};
