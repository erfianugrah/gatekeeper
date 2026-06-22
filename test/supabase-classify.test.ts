import { describe, it, expect } from 'vitest';
import { classifySupabaseRequest } from '../src/supabase/classify';

const REF = 'dewddkcmwrzbpynylyhg';

describe('classifySupabaseRequest', () => {
	// --- existing coverage ---

	it('classifies a SQL query as database:write with the project ref', () => {
		const r = classifySupabaseRequest('POST', `/v1/projects/${REF}/database/query`);
		expect(r).toEqual({
			action: 'supabase:database:write',
			category: 'database',
			write: true,
			projectRef: REF,
			resource: `project:${REF}`,
		});
	});

	it('classifies the read-only SQL endpoint as database:READ despite being POST', () => {
		const r = classifySupabaseRequest('POST', `/v1/projects/${REF}/database/query/read-only`);
		expect(r?.action).toBe('supabase:database:read');
		expect(r?.write).toBe(false);
	});

	it('classifies a deeply-nested auth path (sso provider by id) as auth', () => {
		const r = classifySupabaseRequest('DELETE', `/v1/projects/${REF}/config/auth/sso/providers/p123`);
		expect(r?.action).toBe('supabase:auth:write');
		expect(r?.category).toBe('auth');
	});

	it('classifies reading auth config as auth:read', () => {
		const r = classifySupabaseRequest('GET', `/v1/projects/${REF}/config/auth`);
		expect(r?.action).toBe('supabase:auth:read');
	});

	it('classifies config/database as database, not auth', () => {
		const r = classifySupabaseRequest('GET', `/v1/projects/${REF}/config/database/pooler`);
		expect(r?.category).toBe('database');
	});

	it('classifies network-bans/retrieve as projects:READ despite being POST', () => {
		expect(classifySupabaseRequest('POST', `/v1/projects/${REF}/network-bans/retrieve`)?.write).toBe(false);
		expect(classifySupabaseRequest('POST', `/v1/projects/${REF}/network-bans/retrieve/enriched`)?.write).toBe(false);
	});

	it('classifies a destructive network-ban delete as projects:write', () => {
		expect(classifySupabaseRequest('DELETE', `/v1/projects/${REF}/network-bans`)?.action).toBe('supabase:projects:write');
	});

	it('classifies edge function body fetch (6 segments) as edge_functions:read', () => {
		const r = classifySupabaseRequest('GET', `/v1/projects/${REF}/functions/my-fn/body`);
		expect(r?.action).toBe('supabase:edge_functions:read');
	});

	it('classifies secrets/api-keys/pgsodium under the secrets category', () => {
		expect(classifySupabaseRequest('GET', `/v1/projects/${REF}/secrets`)?.category).toBe('secrets');
		expect(classifySupabaseRequest('GET', `/v1/projects/${REF}/api-keys`)?.category).toBe('secrets');
		expect(classifySupabaseRequest('GET', `/v1/projects/${REF}/pgsodium`)?.category).toBe('secrets');
	});

	it('classifies listing projects as projects:read with no ref', () => {
		const r = classifySupabaseRequest('GET', '/v1/projects');
		expect(r).toEqual({
			action: 'supabase:projects:read',
			category: 'projects',
			write: false,
			projectRef: null,
			resource: 'supabase:account',
		});
	});

	it('treats /v1/projects/available-regions as a projects read, not a ref', () => {
		const r = classifySupabaseRequest('GET', '/v1/projects/available-regions');
		expect(r?.projectRef).toBeNull();
		expect(r?.action).toBe('supabase:projects:read');
	});

	it('classifies creating a project as projects:write', () => {
		expect(classifySupabaseRequest('POST', '/v1/projects')?.action).toBe('supabase:projects:write');
	});

	it('falls back to projects category for unmatched ref-scoped tails (health, upgrade)', () => {
		expect(classifySupabaseRequest('GET', `/v1/projects/${REF}/health`)?.category).toBe('projects');
		expect(classifySupabaseRequest('GET', `/v1/projects/${REF}/upgrade/eligibility`)?.category).toBe('projects');
	});

	it('binds /v1/branches/{id} to a branch resource under environment scope', () => {
		const r = classifySupabaseRequest('GET', '/v1/branches/br_abc');
		expect(r?.category).toBe('environment');
		expect(r?.resource).toBe('branch:br_abc');
	});

	it('classifies organizations as organizations scope', () => {
		const r = classifySupabaseRequest('GET', '/v1/organizations/my-org');
		expect(r?.category).toBe('organizations');
		expect(r?.resource).toBe('org:my-org');
	});

	it('rejects a garbage ref so the proxy can deny-by-default', () => {
		expect(classifySupabaseRequest('GET', '/v1/projects/NOT_A_REF/database/query')).toBeNull();
	});

	it('classifies account-level oauth/profile/snippets groups', () => {
		expect(classifySupabaseRequest('GET', '/v1/oauth/authorize')).toEqual({
			action: 'supabase:oauth:read',
			category: 'oauth',
			write: false,
			projectRef: null,
			resource: 'supabase:account',
		});
		expect(classifySupabaseRequest('POST', '/v1/oauth/token')?.action).toBe('supabase:oauth:write');
		expect(classifySupabaseRequest('GET', '/v1/profile')?.action).toBe('supabase:profile:read');
		expect(classifySupabaseRequest('GET', '/v1/snippets')?.action).toBe('supabase:snippets:read');
		expect(classifySupabaseRequest('GET', '/v1/snippets/sn_123')?.resource).toBe('supabase:account');
	});

	it('returns null for still-out-of-scope groups so the proxy can deny-by-default', () => {
		expect(classifySupabaseRequest('GET', '/v1/some/unmapped/route')).toBeNull();
		expect(classifySupabaseRequest('GET', '/v1/billing/invoices')).toBeNull();
		expect(classifySupabaseRequest('GET', '/health')).toBeNull();
	});

	it('classifies the experimental v0 analytics metrics scrape as metrics:read', () => {
		const r = classifySupabaseRequest('GET', `/v0/projects/${REF}/analytics/metrics`);
		expect(r).toEqual({
			action: 'supabase:metrics:read',
			category: 'metrics',
			write: false,
			projectRef: REF,
			resource: `project:${REF}`,
		});
	});

	it('denies non-GET methods and any other v0 path (treats v0 as unstable)', () => {
		expect(classifySupabaseRequest('POST', `/v0/projects/${REF}/analytics/metrics`)).toBeNull();
		expect(classifySupabaseRequest('GET', `/v0/projects/${REF}/database/query`)).toBeNull();
		expect(classifySupabaseRequest('GET', '/v0/organizations/my-org')).toBeNull();
		expect(classifySupabaseRequest('GET', '/v0/projects/NOT_A_REF/analytics/metrics')).toBeNull();
	});

	// --- G1–G14: new coverage ---

	it('G1: HEAD /secrets → write:false (read), not write', () => {
		const r = classifySupabaseRequest('HEAD', `/v1/projects/${REF}/secrets`);
		expect(r?.write).toBe(false);
		expect(r?.action).toBe('supabase:secrets:read');
		expect(r?.category).toBe('secrets');
	});

	it('G2: PATCH /config/auth → auth:write', () => {
		const r = classifySupabaseRequest('PATCH', `/v1/projects/${REF}/config/auth`);
		expect(r?.action).toBe('supabase:auth:write');
		expect(r?.write).toBe(true);
		expect(r?.category).toBe('auth');
	});

	it('G3: PUT /secrets/MY_SECRET → secrets:write', () => {
		const r = classifySupabaseRequest('PUT', `/v1/projects/${REF}/secrets/MY_SECRET`);
		expect(r?.action).toBe('supabase:secrets:write');
		expect(r?.write).toBe(true);
	});

	it('G4: GET /postgrest → rest category, rest:read', () => {
		const r = classifySupabaseRequest('GET', `/v1/projects/${REF}/postgrest`);
		expect(r?.category).toBe('rest');
		expect(r?.action).toBe('supabase:rest:read');
	});

	it('G5: GET /custom-hostname → domains category', () => {
		const r = classifySupabaseRequest('GET', `/v1/projects/${REF}/custom-hostname`);
		expect(r?.category).toBe('domains');
		expect(r?.action).toBe('supabase:domains:read');
	});

	it('G6: DELETE /vanity-subdomain → domains:write', () => {
		const r = classifySupabaseRequest('DELETE', `/v1/projects/${REF}/vanity-subdomain`);
		expect(r?.category).toBe('domains');
		expect(r?.write).toBe(true);
		expect(r?.action).toBe('supabase:domains:write');
	});

	it('G7: POST /actions/reset → environment:write', () => {
		const r = classifySupabaseRequest('POST', `/v1/projects/${REF}/actions/reset`);
		expect(r?.category).toBe('environment');
		expect(r?.write).toBe(true);
		expect(r?.action).toBe('supabase:environment:write');
	});

	it('G8: DELETE /functions/my-fn → edge_functions:write', () => {
		const r = classifySupabaseRequest('DELETE', `/v1/projects/${REF}/functions/my-fn`);
		expect(r?.action).toBe('supabase:edge_functions:write');
		expect(r?.write).toBe(true);
	});

	it('G9: POST /storage/buckets → storage:write', () => {
		const r = classifySupabaseRequest('POST', `/v1/projects/${REF}/storage/buckets`);
		expect(r?.action).toBe('supabase:storage:write');
		expect(r?.category).toBe('storage');
	});

	it('G10: GET /v1/organizations (collection, no slug) → supabase:account resource, null projectRef', () => {
		const r = classifySupabaseRequest('GET', '/v1/organizations');
		expect(r?.resource).toBe('supabase:account');
		expect(r?.projectRef).toBeNull();
		expect(r?.action).toBe('supabase:organizations:read');
	});

	it('G11: GET /v1/branches (collection, no id) → null (not a valid branch path)', () => {
		expect(classifySupabaseRequest('GET', '/v1/branches')).toBeNull();
	});

	it('G12: query string stripped before classification', () => {
		const r = classifySupabaseRequest('GET', '/v1/projects?foo=bar');
		expect(r?.action).toBe('supabase:projects:read');
		expect(r?.projectRef).toBeNull();
	});

	it('G13: 19-char ref (too short) → null', () => {
		expect(classifySupabaseRequest('GET', '/v1/projects/abcdefghijklmnopqrs/database/query')).toBeNull();
	});

	it('G14: 21-char ref (too long) → null', () => {
		expect(classifySupabaseRequest('GET', '/v1/projects/abcdefghijklmnopqrstu/database/query')).toBeNull();
	});
});
