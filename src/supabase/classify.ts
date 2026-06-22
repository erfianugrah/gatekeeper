/**
 * Supabase Management API request classifier.
 *
 * Maps an inbound `(method, path)` to a Gatekeeper action + project ref so the policy
 * engine can authorize it. This table IS the RBAC surface — adding coverage means adding
 * a tail-prefix to PROJECT_TAIL_CATEGORIES or a READ_OVERRIDES entry (plus a test).
 *
 * Design: longest-prefix category matching on the path tail (the part AFTER
 * `/v1/projects/{ref}/`). This handles arbitrary nesting depth (e.g.
 * `config/auth/sso/providers/{id}`, `database/backups/schedule`, `functions/{slug}/body`)
 * without a row per endpoint. read/write is derived from the HTTP method, with an explicit
 * read-override set for the `POST`-but-read endpoints the OpenAPI spec exposed.
 *
 * Verified against /docs/supabase-api/api/*.md on 2026-06-18.
 */

import { SUPABASE_REF_RE, PROJECT_REF_LITERALS, type SupabaseCategory } from './constants';

export interface SupabaseClassification {
	/** e.g. 'supabase:database:write'. */
	action: string;
	category: SupabaseCategory;
	write: boolean;
	/** Project ref when the route is project-scoped, else null. */
	projectRef: string | null;
	/** 'project:<ref>' | 'branch:<id>' | 'org:<slug>' | 'supabase:account'. */
	resource: string;
}

// Tail-prefix → category. Tail = the path AFTER `/v1/projects/{ref}/`. Longest prefix wins.
const PROJECT_TAIL_CATEGORIES: Array<[string, SupabaseCategory]> = [
	['config/auth', 'auth'],
	['config/database', 'database'],
	['database', 'database'],
	['postgrest', 'rest'],
	['secrets', 'secrets'],
	['api-keys', 'secrets'],
	['pgsodium', 'secrets'],
	['functions', 'edge_functions'],
	['storage', 'storage'],
	['custom-hostname', 'domains'],
	['vanity-subdomain', 'domains'],
	['branches', 'environment'],
	['actions', 'environment'],
	// everything else under a ref (health, upgrade, pause, restart, restore,
	// config/disk, network-bans, network-restrictions, claim-token) falls back to `projects`.
];

// POST/PATCH/PUT/DELETE endpoints that are semantically READS. Keyed by `${method} ${tail-prefix}`.
const READ_OVERRIDES = new Set<string>([
	'POST database/query/read-only',
	'POST network-bans/retrieve',
	'POST network-bans/retrieve/enriched',
]);

function isRead(method: string, tail: string): boolean {
	if (method === 'GET' || method === 'HEAD') return true;
	for (const ov of READ_OVERRIDES) {
		const sep = ov.indexOf(' ');
		const m = ov.slice(0, sep);
		const prefix = ov.slice(sep + 1);
		if (m === method && (tail === prefix || tail.startsWith(prefix + '/'))) return true;
	}
	return false;
}

function categoryForProjectTail(tail: string): SupabaseCategory {
	let best: SupabaseCategory = 'projects';
	let bestLen = -1;
	for (const [prefix, cat] of PROJECT_TAIL_CATEGORIES) {
		if ((tail === prefix || tail.startsWith(prefix + '/')) && prefix.length > bestLen) {
			best = cat;
			bestLen = prefix.length;
		}
	}
	return best;
}

/** Classify a Management API request to a Gatekeeper action. Returns null for unmapped paths (deny-by-default). */
export function classifySupabaseRequest(method: string, path: string): SupabaseClassification | null {
	const segs = path.split('?')[0].split('/').filter(Boolean); // e.g. ['v1','projects','<ref>','database','query']

	// Experimental v0 surface: only the per-project analytics metrics scrape endpoint is mapped
	// (GET /v0/projects/{ref}/analytics/metrics). It is proxied with the caller's stored PAT (Bearer)
	// as an alternative to the Basic-auth /supabase/metrics/:ref route. Anything else under /v0 is
	// unmapped → deny-by-default. The path shape is treated as external/unstable: no other v0 routes
	// are assumed, and only GET/HEAD scrapes are classified.
	if (segs[0] === 'v0') {
		const isScrape =
			segs.length === 5 &&
			segs[1] === 'projects' &&
			segs[3] === 'analytics' &&
			segs[4] === 'metrics' &&
			(method === 'GET' || method === 'HEAD');
		if (!isScrape) return null;
		const ref = segs[2];
		if (!SUPABASE_REF_RE.test(ref)) return null;
		return { action: 'supabase:metrics:read', category: 'metrics', write: false, projectRef: ref, resource: `project:${ref}` };
	}

	if (segs[0] !== 'v1') return null;
	const root = segs[1];

	const mk = (category: SupabaseCategory, projectRef: string | null, resource: string): SupabaseClassification => {
		const tail = segs.slice(projectRef ? 3 : 2).join('/');
		const write = !isRead(method, tail);
		return { action: `supabase:${category}:${write ? 'write' : 'read'}`, category, write, projectRef, resource };
	};

	if (root === 'projects') {
		const maybeRef = segs[2];
		// /v1/projects  and  /v1/projects/available-regions  are project collection reads (no ref).
		if (maybeRef === undefined || PROJECT_REF_LITERALS.has(maybeRef)) {
			return mk('projects', null, 'supabase:account');
		}
		if (!SUPABASE_REF_RE.test(maybeRef)) return null; // garbage ref → deny
		const tail = segs.slice(3).join('/');
		return mk(categoryForProjectTail(tail), maybeRef, `project:${maybeRef}`);
	}

	if (root === 'branches') {
		const id = segs[2];
		if (!id) return null;
		// A branch id-or-ref is not necessarily a project ref — bind to a branch resource.
		return mk('environment', null, `branch:${id}`);
	}

	if (root === 'organizations') {
		const slug = segs[2];
		return mk('organizations', null, slug ? `org:${slug}` : 'supabase:account');
	}

	if (root === 'oauth') {
		return mk('oauth', null, 'supabase:account');
	}

	if (root === 'profile') {
		return mk('profile', null, 'supabase:account');
	}

	if (root === 'snippets') {
		return mk('snippets', null, 'supabase:account');
	}

	// billing / advisors / analytics / realtime groups remain out of scope for v1 → deny-by-default.
	return null;
}
