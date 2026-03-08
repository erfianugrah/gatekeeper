import { Hono } from 'hono';
import { queryDnsEvents, queryDnsSummary } from '../dns/analytics';
import { jsonError, parseQueryParams } from './admin-schemas';
import { z } from 'zod';
import type { DnsAnalyticsQuery } from '../dns/analytics';
import type { HonoEnv } from '../types';

// ─── Admin: DNS Analytics ───────────────────────────────────────────────────

export const adminDnsAnalyticsApp = new Hono<HonoEnv>();

// ─── Query schemas ──────────────────────────────────────────────────────────

const dnsEventsQuerySchema = z.object({
	zone_id: z.string().optional(),
	key_id: z.string().optional(),
	action: z.string().optional(),
	record_type: z.string().optional(),
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
	limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const dnsSummaryQuerySchema = z.object({
	zone_id: z.string().optional(),
	key_id: z.string().optional(),
	action: z.string().optional(),
	record_type: z.string().optional(),
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
});

// ─── Events ─────────────────────────────────────────────────────────────────

adminDnsAnalyticsApp.get('/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'dns-events' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, dnsEventsQuerySchema);
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

	const query = parseQueryParams(c, dnsSummaryQuerySchema);
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
