/**
 * Admin analytics endpoints for Supabase proxy events (Management API + Metrics).
 *
 * Mounted at /admin/supabase/analytics by the admin router.
 * Uses the same Zod + parseQueryParams pattern as the CF/S3/DNS analytics routes.
 */

import { Hono } from 'hono';
import { querySupabaseProxyEvents, querySupabaseProxySummary } from '../supabase/analytics';
import { queryTimeseries } from '../analytics-timeseries';
import {
	jsonError,
	parseQueryParams,
	supabaseProxyAnalyticsEventsQuerySchema,
	supabaseProxyAnalyticsSummaryQuerySchema,
	supabaseProxyTimeseriesQuerySchema,
} from './admin-schemas';
import type { SupabaseProxyAnalyticsQuery } from '../supabase/analytics';
import type { HonoEnv } from '../types';

// ─── Admin: Supabase Proxy Analytics ────────────────────────────────────────

export const adminSupabaseAnalyticsApp = new Hono<HonoEnv>();

// ─── Events ─────────────────────────────────────────────────────────────────

adminSupabaseAnalyticsApp.get('/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'supabase-proxy-events' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, supabaseProxyAnalyticsEventsQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: SupabaseProxyAnalyticsQuery = {
		project_ref: query.project_ref,
		key_id: query.key_id,
		category: query.category,
		action: query.action,
		since: query.since,
		until: query.until,
		limit: query.limit,
	};

	const events = await querySupabaseProxyEvents(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.supabase.analytics.events',
			projectRef: query.project_ref ?? 'all',
			count: events.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: events });
});

// ─── Summary ────────────────────────────────────────────────────────────────

adminSupabaseAnalyticsApp.get('/summary', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'supabase-proxy-summary' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, supabaseProxyAnalyticsSummaryQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: SupabaseProxyAnalyticsQuery = {
		project_ref: query.project_ref,
		key_id: query.key_id,
		category: query.category,
		action: query.action,
		since: query.since,
		until: query.until,
	};

	const summary = await querySupabaseProxySummary(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.supabase.analytics.summary',
			projectRef: query.project_ref ?? 'all',
			totalRequests: summary.total_requests,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: summary });
});

// ─── Timeseries ───────────────────────────────────────────────────────────────

adminSupabaseAnalyticsApp.get('/timeseries', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'supabase-proxy-timeseries' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, supabaseProxyTimeseriesQuerySchema);
	if (query instanceof Response) return query;

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.project_ref) {
		conditions.push('project_ref = ?');
		params.push(query.project_ref);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.category) {
		conditions.push('category = ?');
		params.push(query.category);
	}
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}

	const buckets = await queryTimeseries(
		c.env.ANALYTICS_DB,
		'supabase_proxy_events',
		{ conditions, params },
		{ since: query.since, until: query.until },
	);

	return c.json({ success: true, result: buckets });
});
