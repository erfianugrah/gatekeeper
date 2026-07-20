/**
 * Admin analytics endpoints for Supabase membership audit events (plan Task 5).
 *
 * Mounted at /admin/supabase/membership by the admin router.
 * Follows the sibling convention: /events + /summary + /timeseries.
 */

import { Hono } from 'hono';
import { queryMembershipEvents, queryMembershipSummary } from '../supabase/membership-analytics';
import { queryTimeseries } from '../analytics-timeseries';
import { buildKeyIdFilter } from '../analytics-identifiers';
import {
	jsonError,
	parseQueryParams,
	supabaseMembershipEventsQuerySchema,
	supabaseMembershipSummaryQuerySchema,
	supabaseMembershipTimeseriesQuerySchema,
} from './admin-schemas';
import type { SupabaseMembershipQuery } from '../supabase/membership-analytics';
import type { HonoEnv } from '../types';

// ─── Admin: Supabase Membership Audit ───────────────────────────────────────

export const adminSupabaseMembershipApp = new Hono<HonoEnv>();

// ─── Events ─────────────────────────────────────────────────────────────────

adminSupabaseMembershipApp.get('/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'supabase-membership-events' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, supabaseMembershipEventsQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: SupabaseMembershipQuery = {
		org_slug: query.org_slug,
		key_id: query.key_id,
		action: query.action,
		outcome: query.outcome,
		target_email: query.target_email,
		since: query.since,
		until: query.until,
		limit: query.limit,
	};

	const events = await queryMembershipEvents(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.supabase.membership.events',
			orgSlug: query.org_slug ?? 'all',
			count: events.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: events });
});

// ─── Summary ────────────────────────────────────────────────────────────────

adminSupabaseMembershipApp.get('/summary', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'supabase-membership-summary' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, supabaseMembershipSummaryQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: SupabaseMembershipQuery = {
		org_slug: query.org_slug,
		key_id: query.key_id,
		action: query.action,
		outcome: query.outcome,
		target_email: query.target_email,
		since: query.since,
		until: query.until,
	};

	const summary = await queryMembershipSummary(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.supabase.membership.summary',
			orgSlug: query.org_slug ?? 'all',
			totalEvents: summary.total_events,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: summary });
});

// ─── Timeseries ─────────────────────────────────────────────────────────────

adminSupabaseMembershipApp.get('/timeseries', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'supabase-membership-timeseries' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, supabaseMembershipTimeseriesQuerySchema);
	if (query instanceof Response) return query;

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.org_slug) {
		conditions.push('org_slug = ?');
		params.push(query.org_slug);
	}
	if (query.key_id) {
		const keyFilter = await buildKeyIdFilter(query.key_id);
		conditions.push(keyFilter.condition);
		params.push(...keyFilter.params);
	}
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.outcome) {
		conditions.push('outcome = ?');
		params.push(query.outcome);
	}

	const buckets = await queryTimeseries(
		c.env.ANALYTICS_DB,
		'supabase_membership_events',
		{ conditions, params },
		{ since: query.since, until: query.until },
		{ errorCondition: "outcome IN ('denied', 'failed')" },
	);

	return c.json({ success: true, result: buckets });
});
