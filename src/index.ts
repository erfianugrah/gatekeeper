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
import { getStub } from './do-stub';
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

// ─── Logout — clears Access session and redirects back to dashboard ─────────

app.get('/logout', (c) => {
	const teamName = c.env.CF_ACCESS_TEAM_NAME;
	if (!teamName) {
		return c.redirect('/dashboard/');
	}

	const accessOrigin = `https://${teamName}.cloudflareaccess.com`;
	const accessLogoutUrl = `${accessOrigin}/cdn-cgi/access/logout`;
	const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signing out…</title></head>
<body>
<p>Signing out…</p>
<script>
// Hit the Access logout endpoint to clear the session, then redirect back to the dashboard.
// Access will catch the unauthenticated request and show the login page.
fetch("${accessLogoutUrl}", { mode: "no-cors", credentials: "include" })
  .finally(function() { setTimeout(function() { window.location.replace("/dashboard/"); }, 500); });
</script>
<noscript><meta http-equiv="refresh" content="2;url=/dashboard/"></noscript>
</body></html>`;

	return c.html(html, 200, {
		'Cache-Control': 'no-store',
		'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; connect-src ${accessOrigin}; style-src 'unsafe-inline'`,
		'Set-Cookie': 'CF_Authorization=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
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

	/** Cron-triggered retention job — deletes analytics events older than retention_days config. */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		try {
			const stub = getStub(env);
			const gwConfig = await stub.getConfig();
			const retentionDays = gwConfig.retention_days;

			const [purgeDeleted, s3Deleted, dnsDeleted, cfProxyDeleted, auditDeleted] = await Promise.all([
				deleteOldEvents(env.ANALYTICS_DB, retentionDays),
				deleteOldS3Events(env.ANALYTICS_DB, retentionDays),
				deleteOldDnsEvents(env.ANALYTICS_DB, retentionDays),
				deleteOldCfProxyEvents(env.ANALYTICS_DB, retentionDays),
				deleteOldAuditEvents(env.ANALYTICS_DB, retentionDays),
			]);
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
