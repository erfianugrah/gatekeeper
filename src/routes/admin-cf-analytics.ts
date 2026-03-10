/**
 * Admin analytics endpoints for CF API proxy events.
 *
 * Mounted at /admin/cf/analytics by the admin router.
 * Uses the same Zod + parseQueryParams pattern as purge, S3, and DNS analytics.
 */

import { Hono } from 'hono';
import { queryCfProxyEvents, queryCfProxySummary } from '../cf/analytics';
import { queryTimeseries } from '../analytics-timeseries';
import {
	jsonError,
	parseQueryParams,
	cfProxyAnalyticsEventsQuerySchema,
	cfProxyAnalyticsSummaryQuerySchema,
	cfProxyTimeseriesQuerySchema,
} from './admin-schemas';
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

// ─── Timeseries ─────────────────────────────────────────────────────────────

adminCfAnalyticsApp.get('/timeseries', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, cfProxyTimeseriesQuerySchema);
	if (query instanceof Response) return query;

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.account_id) {
		conditions.push('account_id = ?');
		params.push(query.account_id);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.service) {
		conditions.push('service = ?');
		params.push(query.service);
	}
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}

	const buckets = await queryTimeseries(
		c.env.ANALYTICS_DB,
		'cf_proxy_events',
		{ conditions, params },
		{ since: query.since, until: query.until },
	);

	return c.json({ success: true, result: buckets });
});
