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

// ─── Login page — redirect to dashboard SPA login page ──────────────────────

app.get('/login', (c) => c.redirect('/dashboard/login', 302));

// ─── Auth routes (login, logout, session, bootstrap) ────────────────────────

app.route('/auth', authApp);

// ─── Logout — clears Access session and redirects back to dashboard ─────────

app.get('/logout', (c) => {
	const teamName = c.env.CF_ACCESS_TEAM_NAME;
	if (!teamName) {
		// No Access configured — clear session cookie and redirect to login
		return new Response(null, {
			status: 302,
			headers: {
				Location: '/dashboard/login',
				'Set-Cookie': 'gk_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
			},
		});
	}

	const accessOrigin = `https://${teamName}.cloudflareaccess.com`;
	const accessLogoutUrl = `${accessOrigin}/cdn-cgi/access/logout`;
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Signing out… — Gatekeeper</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background-color: #15161e;
  color: #fcfcfc;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

.backdrop-glow {
  position: fixed;
  inset: 0;
  background: radial-gradient(ellipse 600px 400px at 50% 45%, rgba(197,116,221,0.08) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

.splash {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2rem;
  animation: fadeIn 0.6s ease-out both;
}

.shield {
  width: 64px;
  height: 64px;
  animation: floatIn 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.shield path { stroke: #c574dd; }
.shield circle, .shield rect { fill: #c574dd; }

.title {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #c574dd;
  text-shadow:
    0 0 10px rgba(197,116,221,0.5),
    0 0 20px rgba(197,116,221,0.3),
    0 0 40px rgba(197,116,221,0.1);
  animation: fadeIn 0.8s ease-out 0.2s both;
}

.progress-track {
  width: 160px;
  height: 2px;
  background: #343647;
  border-radius: 1px;
  overflow: hidden;
  animation: fadeIn 0.6s ease-out 0.4s both;
}
.progress-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #c574dd, #8796f4);
  border-radius: 1px;
  animation: fill 1.2s ease-in-out 0.5s forwards;
}

.subtitle {
  font-size: 0.75rem;
  color: #bdbdc1;
  animation: fadeIn 0.6s ease-out 0.5s both;
}
.subtitle a {
  color: #c574dd;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s;
}
.subtitle a:hover {
  border-bottom-color: #c574dd;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes floatIn {
  from { opacity: 0; transform: translateY(-12px) scale(0.9); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes fill {
  to { width: 100%; }
}
</style>
</head>
<body>
<div class="backdrop-glow"></div>
<div class="splash">
  <svg class="shield" viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linejoin="round">
    <path d="M12 2 L3 6.5 L3 12 C3 18.5 6.8 23 12 24.5 C17.2 23 21 18.5 21 12 L21 6.5 Z" />
    <circle cx="12" cy="11" r="2.5" />
    <rect x="11" y="13" width="2" height="4" rx="0.8" />
  </svg>
  <div class="title">Signing out</div>
  <div class="progress-track"><div class="progress-fill"></div></div>
  <div class="subtitle">Clearing your session…</div>
  <noscript>
    <div class="subtitle"><a href="/dashboard/">Continue to dashboard</a></div>
  </noscript>
</div>
<script>
fetch("${accessLogoutUrl}", { mode: "no-cors", credentials: "include" })
  .finally(function() { setTimeout(function() { window.location.replace("/dashboard/"); }, 1500); });
</script>
</body>
</html>`;

	return c.html(html, 200, {
		'Cache-Control': 'no-store',
		'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; connect-src ${accessOrigin}; style-src 'unsafe-inline'; img-src /favicon.svg`,
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
