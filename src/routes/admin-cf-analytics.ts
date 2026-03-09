/**
 * Admin analytics endpoints for CF API proxy events.
 *
 * Mounted at /admin/cf/analytics by the admin router.
 * Uses the same Zod + parseQueryParams pattern as purge, S3, and DNS analytics.
 */

import { Hono } from 'hono';
import { queryCfProxyEvents, queryCfProxySummary } from '../cf/analytics';
import { jsonError, parseQueryParams, cfProxyAnalyticsEventsQuerySchema, cfProxyAnalyticsSummaryQuerySchema } from './admin-schemas';
import type { CfProxyAnalyticsQuery } from '../cf/analytics';
import type { HonoEnv } from '../types';

// ─── Admin: CF Proxy Analytics ──────────────────────────────────────────────

export const adminCfAnalyticsApp = new Hono<HonoEnv>();

// ─── Events ─────────────────────────────────────────────────────────────────

adminCfAnalyticsApp.get('/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'cf-proxy-events' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, cfProxyAnalyticsEventsQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: CfProxyAnalyticsQuery = {
		account_id: query.account_id,
		key_id: query.key_id,
		service: query.service,
		action: query.action,
		since: query.since,
		until: query.until,
		limit: query.limit,
	};

	const events = await queryCfProxyEvents(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.cf.analytics.events',
			accountId: query.account_id ?? 'all',
			service: query.service ?? 'all',
			count: events.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: events });
});

// ─── Summary ────────────────────────────────────────────────────────────────

adminCfAnalyticsApp.get('/summary', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'cf-proxy-summary' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, cfProxyAnalyticsSummaryQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: CfProxyAnalyticsQuery = {
		account_id: query.account_id,
		key_id: query.key_id,
		service: query.service,
		action: query.action,
		since: query.since,
		until: query.until,
	};

	const summary = await queryCfProxySummary(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.cf.analytics.summary',
			accountId: query.account_id ?? 'all',
			service: query.service ?? 'all',
			totalRequests: summary.total_requests,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: summary });
});
