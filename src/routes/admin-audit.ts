import { Hono } from 'hono';
import { queryAuditEvents } from '../audit-log';
import { auditEventsQuerySchema, jsonError, parseQueryParams } from './admin-schemas';
import type { AuditQuery } from '../audit-log';
import type { HonoEnv } from '../types';

// ─── Admin: Audit Log ───────────────────────────────────────────────────────

export const adminAuditApp = new Hono<HonoEnv>();

// ─── Events ─────────────────────────────────────────────────────────────────

adminAuditApp.get('/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'audit-events' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, auditEventsQuerySchema);
	if (query instanceof Response) return query;

	const auditQuery: AuditQuery = {
		action: query.action,
		actor: query.actor,
		entity_type: query.entity_type,
		entity_id: query.entity_id,
		since: query.since,
		until: query.until,
		limit: query.limit,
	};

	const events = await queryAuditEvents(c.env.ANALYTICS_DB, auditQuery);

	console.log(
		JSON.stringify({
			route: 'admin.audit.events',
			count: events.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: events });
});
