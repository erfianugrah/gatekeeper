import { Hono } from 'hono';
import { queryEvents, querySummary } from '../analytics';
import { purgeAnalyticsEventsQuerySchema, purgeAnalyticsSummaryQuerySchema, jsonError, parseQueryParams } from './admin-schemas';
import type { AnalyticsQuery } from '../analytics';
import type { HonoEnv } from '../types';

// ─── Admin: Purge Analytics ─────────────────────────────────────────────────

export const adminAnalyticsApp = new Hono<HonoEnv>();

// ─── Events ─────────────────────────────────────────────────────────────────

adminAnalyticsApp.get('/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, purgeAnalyticsEventsQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: AnalyticsQuery = {
		zone_id: query.zone_id,
		key_id: query.key_id,
		since: query.since,
		until: query.until,
		limit: query.limit,
	};

	const events = await queryEvents(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.analytics.events',
			zoneId: query.zone_id ?? 'all',
			count: events.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: events });
});

// ─── Summary ────────────────────────────────────────────────────────────────

adminAnalyticsApp.get('/summary', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, purgeAnalyticsSummaryQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: AnalyticsQuery = {
		zone_id: query.zone_id,
		key_id: query.key_id,
		since: query.since,
		until: query.until,
	};

	const summary = await querySummary(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.analytics.summary',
			zoneId: query.zone_id ?? 'all',
			totalRequests: summary.total_requests,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: summary });
});
