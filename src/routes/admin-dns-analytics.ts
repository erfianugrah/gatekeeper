/**
 * Admin analytics endpoints for DNS proxy events.
 *
 * Mounted at /admin/dns/analytics by the admin router.
 * Uses the same Zod + parseQueryParams pattern as purge and S3 analytics.
 */

import { Hono } from 'hono';
import { queryDnsEvents, queryDnsSummary } from '../cf/dns/analytics';
import { queryTimeseries } from '../analytics-timeseries';
import {
	jsonError,
	parseQueryParams,
	dnsAnalyticsEventsQuerySchema,
	dnsAnalyticsSummaryQuerySchema,
	dnsTimeseriesQuerySchema,
} from './admin-schemas';
import type { DnsAnalyticsQuery } from '../cf/dns/analytics';
import type { HonoEnv } from '../types';

// ─── Admin: DNS Analytics ───────────────────────────────────────────────────

export const adminDnsAnalyticsApp = new Hono<HonoEnv>();

// ─── Events ─────────────────────────────────────────────────────────────────

adminDnsAnalyticsApp.get('/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'dns-events' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, dnsAnalyticsEventsQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: DnsAnalyticsQuery = {
		zone_id: query.zone_id,
		key_id: query.key_id,
		action: query.action,
		record_type: query.record_type,
		since: query.since,
		until: query.until,
		limit: query.limit,
	};

	const events = await queryDnsEvents(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.dns.analytics.events',
			zoneId: query.zone_id ?? 'all',
			count: events.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: events });
});

// ─── Summary ────────────────────────────────────────────────────────────────

adminDnsAnalyticsApp.get('/summary', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'dns-summary' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, dnsAnalyticsSummaryQuerySchema);
	if (query instanceof Response) return query;

	const analyticsQuery: DnsAnalyticsQuery = {
		zone_id: query.zone_id,
		key_id: query.key_id,
		action: query.action,
		record_type: query.record_type,
		since: query.since,
		until: query.until,
	};

	const summary = await queryDnsSummary(c.env.ANALYTICS_DB, analyticsQuery);

	console.log(
		JSON.stringify({
			route: 'admin.dns.analytics.summary',
			zoneId: query.zone_id ?? 'all',
			totalRequests: summary.total_requests,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: summary });
});

// ─── Timeseries ─────────────────────────────────────────────────────────────

adminDnsAnalyticsApp.get('/timeseries', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, dnsTimeseriesQuerySchema);
	if (query instanceof Response) return query;

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.zone_id) {
		conditions.push('zone_id = ?');
		params.push(query.zone_id);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.record_type) {
		conditions.push('record_type = ?');
		params.push(query.record_type);
	}

	const buckets = await queryTimeseries(
		c.env.ANALYTICS_DB,
		'dns_events',
		{ conditions, params },
		{ since: query.since, until: query.until },
	);

	return c.json({ success: true, result: buckets });
});
