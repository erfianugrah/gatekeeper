import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// ─── Constants ──────────────────────────────────────────────────────────────

const REF = 'dewddkcmwrzbpynylyhg'; // a real 20-char lowercase project ref shape
const REF_OTHER = 'zzzzzzzzzzzzzzzzzzzz';

/** Get the DO stub for direct RPC calls. */
function getStub() {
	return env.GATEKEEPER.get(env.GATEKEEPER.idFromName('account'));
}

describe('supabase credential resolution', () => {
	it('resolves a supabase PAT (bearer) by project ref', async () => {
		const stub = getStub();
		const { token } = await stub.createUpstreamToken({
			name: 'pat-prod',
			token: 'sbp_pat_secret_value',
			scope_type: 'supabase',
			zone_ids: [REF],
		});
		try {
			expect(await stub.resolveSupabaseToken(REF)).toBe('sbp_pat_secret_value');
			expect(await stub.resolveSupabaseToken(REF_OTHER)).toBeNull();
		} finally {
			await stub.deleteUpstreamToken(token.id);
		}
	});

	it('resolves a metrics Basic credential (username + secret) by project ref', async () => {
		const stub = getStub();
		const { token } = await stub.createUpstreamToken({
			name: 'metrics-prod',
			token: 'sb_secret_metrics_value',
			scope_type: 'supabase_metrics',
			auth_type: 'basic',
			username: 'service_role',
			zone_ids: [REF],
		});
		try {
			const cred = await stub.resolveSupabaseMetricsCredential(REF);
			expect(cred).toEqual({ username: 'service_role', secret: 'sb_secret_metrics_value' });
		} finally {
			await stub.deleteUpstreamToken(token.id);
		}
	});

	it('defaults the metrics username to service_role when none stored', async () => {
		const stub = getStub();
		const { token } = await stub.createUpstreamToken({
			name: 'metrics-no-user',
			token: 'sb_secret_no_user',
			scope_type: 'supabase_metrics',
			auth_type: 'basic',
			zone_ids: ['*'],
		});
		try {
			const cred = await stub.resolveSupabaseMetricsCredential('anyrefatallhere1234');
			expect(cred).toEqual({ username: 'service_role', secret: 'sb_secret_no_user' });
		} finally {
			await stub.deleteUpstreamToken(token.id);
		}
	});

	it('does not leak secrets via listTokens', async () => {
		const stub = getStub();
		const { token } = await stub.createUpstreamToken({
			name: 'leak-check',
			token: 'sbp_should_not_appear',
			scope_type: 'supabase',
			zone_ids: [REF],
		});
		try {
			const list = await stub.listUpstreamTokens();
			for (const t of list) expect((t as any).token).toBeUndefined();
		} finally {
			await stub.deleteUpstreamToken(token.id);
		}
	});

	it('keeps supabase and supabase_metrics scopes isolated from each other', async () => {
		const stub = getStub();
		const pat = await stub.createUpstreamToken({ name: 'iso-pat', token: 'sbp_iso', scope_type: 'supabase', zone_ids: [REF] });
		const met = await stub.createUpstreamToken({
			name: 'iso-met',
			token: 'sb_secret_iso',
			scope_type: 'supabase_metrics',
			auth_type: 'basic',
			username: 'service_role',
			zone_ids: [REF],
		});
		try {
			// PAT resolver must not return the metrics secret and vice-versa.
			expect(await stub.resolveSupabaseToken(REF)).toBe('sbp_iso');
			expect((await stub.resolveSupabaseMetricsCredential(REF))?.secret).toBe('sb_secret_iso');
		} finally {
			await stub.deleteUpstreamToken(pat.token.id);
			await stub.deleteUpstreamToken(met.token.id);
		}
	});
});
