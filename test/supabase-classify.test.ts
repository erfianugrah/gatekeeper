import { describe, it, expect } from 'vitest';
import { classifySupabaseRequest } from '../src/supabase/classify';

const REF = 'dewddkcmwrzbpynylyhg';

describe('classifySupabaseRequest', () => {
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

	it('returns null for out-of-scope groups so the proxy can deny-by-default', () => {
		expect(classifySupabaseRequest('GET', '/v1/oauth/authorize')).toBeNull();
		expect(classifySupabaseRequest('GET', '/v1/some/unmapped/route')).toBeNull();
		expect(classifySupabaseRequest('GET', '/health')).toBeNull();
	});
});
