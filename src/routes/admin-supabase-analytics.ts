/**
 * Admin analytics endpoints for Supabase proxy events (Management API + Metrics).
 *
 * Mounted at /admin/supabase/analytics by the admin router.
 * Uses the same Zod + parseQueryParams pattern as the CF/S3/DNS analytics routes.
 */

import { Hono } from 'hono';
import { querySupabaseProxyEvents, querySupabaseProxySummary } from '../supabase/analytics';
import {
	jsonError,
	parseQueryParams,
	supabaseProxyAnalyticsEventsQuerySchema,
	supabaseProxyAnalyticsSummaryQuerySchema,
} from './admin-schemas';
import type { SupabaseProxyAnalyticsQuery } from '../supabase/analytics';
import type { HonoEnv } from '../types';

// ─── Admin: Supabase Proxy Analytics ────────────────────────────────────────

export const adminSupabaseAnalyticsApp = new Hono<HonoEnv>();

// ─── Events ─────────────────────────────────────────────────────────────────

adminSupabaseAnalyticsApp.get('/', async (c) => {
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
