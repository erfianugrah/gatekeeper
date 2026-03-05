import { Hono } from "hono";
import { purgeRoute, __testClearInflightCache } from "./routes/purge";
import { adminApp } from "./routes/admin";
import { s3App } from "./s3/routes";
import { deleteOldEvents } from "./analytics";
import type { HonoEnv } from "./types";

// Re-export DO class — wrangler requires it from the main entrypoint
export { PurgeRateLimiter } from "./durable-object";

// Re-export for tests
export { __testClearInflightCache };

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", purgeRoute);
app.route("/admin", adminApp);
app.route("/s3", s3App);

// ─── Exports ────────────────────────────────────────────────────────────────

export default {
	fetch: app.fetch,

	/** Cron-triggered retention job — deletes analytics events older than RETENTION_DAYS. */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const retentionDays = Number(env.RETENTION_DAYS) || 30;
		try {
			const deleted = await deleteOldEvents(env.ANALYTICS_DB, retentionDays);
			console.log(JSON.stringify({
				event: 'retention_cron',
				cron: controller.cron,
				retentionDays,
				deleted,
				ts: new Date(controller.scheduledTime).toISOString(),
			}));
		} catch (e: any) {
			console.error(JSON.stringify({
				event: 'retention_cron_error',
				cron: controller.cron,
				error: e.message,
			}));
		}
	},
};
