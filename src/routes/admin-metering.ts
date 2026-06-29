/**
 * Unified cross-surface metering endpoint.
 *
 * Mounted at /admin/metering. Aggregates per-tenant cost across ALL proxy surfaces
 * (purge, dns, cf, supabase, s3), unifying on created_by — the only column present
 * in every event table.
 */

import { Hono } from 'hono';
import { queryMeteringAcrossSurfaces } from '../analytics-metering';
import { jsonError, parseQueryParams, crossSurfaceMeteringQuerySchema } from './admin-schemas';
import type { HonoEnv } from '../types';

export const adminMeteringApp = new Hono<HonoEnv>();

adminMeteringApp.get('/', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'metering' }));
		return jsonError(c, 503, 'Analytics not configured');
	}
	const query = parseQueryParams(c, crossSurfaceMeteringQuerySchema);
	if (query instanceof Response) return query;

	const rows = await queryMeteringAcrossSurfaces(c.env.ANALYTICS_DB, query);

	console.log(JSON.stringify({ route: 'admin.metering', tenants: rows.length, ts: new Date().toISOString() }));

	return c.json({ success: true, result: rows });
});
