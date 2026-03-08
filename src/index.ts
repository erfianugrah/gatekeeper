import { Hono } from 'hono';
import { purgeRoute, __testClearInflightCache } from './routes/purge';
import { dnsRoute } from './dns/routes';
import { adminApp } from './routes/admin';
import { s3App } from './s3/routes';
import { deleteOldEvents } from './analytics';
import { deleteOldS3Events } from './s3/analytics';
import { deleteOldDnsEvents } from './dns/analytics';
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
		c.header(name, value);
	}
});

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', purgeRoute);
app.route('/', dnsRoute);
app.route('/admin', adminApp);
app.route('/s3', s3App);

// ─── Exports ────────────────────────────────────────────────────────────────

export default {
	fetch: app.fetch,

	/** Cron-triggered retention job — deletes analytics events older than retention_days config. */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		try {
			const stub = getStub(env);
			const gwConfig = await stub.getConfig();
			const retentionDays = gwConfig.retention_days;

			const [purgeDeleted, s3Deleted, dnsDeleted] = await Promise.all([
				deleteOldEvents(env.ANALYTICS_DB, retentionDays),
				deleteOldS3Events(env.ANALYTICS_DB, retentionDays),
				deleteOldDnsEvents(env.ANALYTICS_DB, retentionDays),
			]);
			console.log(
				JSON.stringify({
					event: 'retention_cron',
					cron: controller.cron,
					retentionDays,
					purgeDeleted,
					s3Deleted,
					dnsDeleted,
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
