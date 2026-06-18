/**
 * Coverage provider: Cloudflare API proxy.
 *
 * Spec-backed and route-introspected. The proxy fronts a deliberate subset of the CF API
 * (KV, D1, Workers, Queues, Vectorize, Hyperdrive, DNS records). This provider fetches CF's
 * published OpenAPI doc, filters it to the sub-resource prefixes we actually proxy, and checks
 * coverage by matching each op against the **real Hono routes** registered by each service
 * sub-app (read via `app.routes` — no handler execution, no `cloudflare:workers` import in the graph).
 *
 * Drift this catches: CF adds/moves an endpoint under a resource we already proxy (e.g. a new
 * `/scripts/{name}/...`) and the router has no matching route. Endpoints under our prefixes that
 * we intentionally don't proxy (streaming live-tail, deprecated shapes) live in `allowlist`.
 * The huge remainder of the CF API is out of surface entirely (never filtered in), so it is not
 * noise — only the parts we claim to proxy are policed.
 */

import { kvRoutes } from '../../../src/cf/kv/routes';
import { d1Routes } from '../../../src/cf/d1/routes';
import { workersRoutes } from '../../../src/cf/workers/routes';
import { queuesRoutes } from '../../../src/cf/queues/routes';
import { vectorizeRoutes } from '../../../src/cf/vectorize/routes';
import { hyperdriveRoutes } from '../../../src/cf/hyperdrive/routes';
import { dnsRoutes } from '../../../src/cf/dns/routes';
import { extractOpenApiOps, opKey, type ApiOp, type CoverageProvider, type SnapshotOp } from '../types';
import snapshot from '../fixtures/cloudflare.ops.json';

const SPEC_URL = 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json';

/** Minimal structural view of a Hono sub-app — we only read its registered routes, never run it. */
interface RouteApp {
	routes: ReadonlyArray<{ method: string; path: string }>;
}

interface Service {
	id: string;
	/** Hono sub-app whose registered routes define what we cover. */
	app: RouteApp;
	/** Path prefix the sub-app is mounted at in `src/cf/router.ts` (template tokens match the CF spec). */
	mountPrefix: string;
	/** CF-spec path prefixes we proxy. An op is "in surface" iff its path starts with one of these. */
	surfacePrefixes: string[];
}

const SERVICES: Service[] = [
	{ id: 'kv', app: kvRoutes, mountPrefix: '/accounts/{account_id}/storage/kv', surfacePrefixes: ['/accounts/{account_id}/storage/kv'] },
	{ id: 'd1', app: d1Routes, mountPrefix: '/accounts/{account_id}/d1', surfacePrefixes: ['/accounts/{account_id}/d1/database'] },
	{
		id: 'workers',
		app: workersRoutes,
		mountPrefix: '/accounts/{account_id}/workers',
		surfacePrefixes: [
			'/accounts/{account_id}/workers/scripts',
			'/accounts/{account_id}/workers/scripts-search',
			'/accounts/{account_id}/workers/account-settings',
			'/accounts/{account_id}/workers/domains',
			'/accounts/{account_id}/workers/subdomain',
			'/accounts/{account_id}/workers/observability/telemetry',
		],
	},
	{ id: 'queues', app: queuesRoutes, mountPrefix: '/accounts/{account_id}/queues', surfacePrefixes: ['/accounts/{account_id}/queues'] },
	{
		id: 'vectorize',
		app: vectorizeRoutes,
		mountPrefix: '/accounts/{account_id}/vectorize',
		surfacePrefixes: ['/accounts/{account_id}/vectorize/v2'],
	},
	{
		id: 'hyperdrive',
		app: hyperdriveRoutes,
		mountPrefix: '/accounts/{account_id}/hyperdrive',
		surfacePrefixes: ['/accounts/{account_id}/hyperdrive'],
	},
	{ id: 'dns', app: dnsRoutes, mountPrefix: '/zones/{zone_id}', surfacePrefixes: ['/zones/{zone_id}/dns_records'] },
];

/** Compile a Hono route pattern (`/a/:id/values/*`) to an anchored regex. */
function patternToRegex(pattern: string): RegExp {
	const body = pattern
		.split('/')
		.map((seg) => {
			if (seg === '') return '';
			if (seg === '*' || seg.startsWith('*')) return '.*';
			if (seg.startsWith(':')) return '[^/]+';
			return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		})
		.join('/');
	return new RegExp(`^${body || '/'}$`);
}

/** Concrete relative path: strip the mount prefix and replace `{param}` spec tokens with a literal segment. */
function relativePath(specPath: string, mountPrefix: string): string {
	const rel = specPath.slice(mountPrefix.length).replace(/\{[^}]+\}/g, '_');
	return rel === '' ? '/' : rel;
}

/** Per-service compiled route matchers, keyed by service id. Built once. */
const MATCHERS = new Map<string, Array<{ method: string; re: RegExp }>>(
	SERVICES.map((svc) => {
		const seen = new Set<string>();
		const routes: Array<{ method: string; re: RegExp }> = [];
		for (const r of svc.app.routes) {
			if (r.method === 'ALL') continue; // middleware, not a handler — would match everything
			const key = `${r.method} ${r.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			routes.push({ method: r.method.toUpperCase(), re: patternToRegex(r.path) });
		}
		return [svc.id, routes] as const;
	}),
);

function serviceFor(specPath: string): Service | undefined {
	return SERVICES.find((svc) => svc.surfacePrefixes.some((p) => specPath === p || specPath.startsWith(`${p}/`)));
}

export const cloudflareProvider: CoverageProvider = {
	id: 'cloudflare',
	label: 'Cloudflare API proxy',
	snapshotPath: 'scripts/api-coverage/fixtures/cloudflare.ops.json',
	snapshot: snapshot as SnapshotOp[],

	async fetchLiveOps(): Promise<ApiOp[]> {
		const res = await fetch(SPEC_URL, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`Cloudflare spec fetch failed: HTTP ${res.status}`);
		const all = extractOpenApiOps(await res.json());
		// Keep only ops under the sub-resource prefixes we proxy — the rest of the CF API is out of scope.
		return all.filter((op) => serviceFor(op.path));
	},

	isCovered(op: ApiOp): boolean {
		const svc = serviceFor(op.path);
		if (!svc) return false;
		const rel = relativePath(op.path, svc.mountPrefix);
		const method = op.method.toUpperCase();
		return (MATCHERS.get(svc.id) ?? []).some((r) => r.method === method && r.re.test(rel));
	},

	// CF-spec endpoints under our proxied resources that we intentionally do NOT proxy.
	// Each is a conscious skip surfaced by `npm run check:api-coverage`, not a silent gap.
	allowlist: {
		'DELETE /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/bulk':
			'legacy bulk-delete shape — we proxy POST /bulk/delete instead',
		'PATCH /accounts/{account_id}/workers/scripts/{script_name}/secrets-bulk': 'bulk secrets write not proxied — individual /secrets is',
		'GET /accounts/{account_id}/workers/scripts/{script_name}/usage-model':
			'deprecated usage-model endpoint — superseded by script settings',
		'PUT /accounts/{account_id}/workers/scripts/{script_name}/usage-model':
			'deprecated usage-model endpoint — superseded by script settings',
		'POST /accounts/{account_id}/workers/observability/telemetry/live-tail': 'streaming live-tail not proxied (long-lived connection)',
		'POST /accounts/{account_id}/workers/observability/telemetry/live-tail/heartbeat':
			'streaming live-tail not proxied (long-lived connection)',
		'GET /accounts/{account_id}/queues/{queue_id}/metrics': 'queue metrics not proxied — not part of the queue control surface',
		'POST /accounts/{account_id}/queues/{queue_id}/messages/preview': 'message preview not proxied — pull/ack are',
		'POST /accounts/{account_id}/queues/{queue_id}/messages/preview/ack': 'message preview not proxied — pull/ack are',
		'POST /zones/{zone_id}/dns_records/scan': 'DNS zone-scan feature not proxied — CRUD + batch + import/export are',
		'POST /zones/{zone_id}/dns_records/scan/trigger': 'DNS zone-scan feature not proxied — CRUD + batch + import/export are',
		'GET /zones/{zone_id}/dns_records/scan/review': 'DNS zone-scan feature not proxied — CRUD + batch + import/export are',
		'POST /zones/{zone_id}/dns_records/scan/review': 'DNS zone-scan feature not proxied — CRUD + batch + import/export are',
	},
};

export { opKey };
