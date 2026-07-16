/**
 * CONFORMANCE SUITE for dry-run preview on the invitations route (plan Section 4).
 *
 * POST /supabase/members/:slug/invitations?dry_run=true returns a 200 PREVIEW:
 * it fetches current membership via the Supabase List endpoint (which works upstream),
 * diffs the requested assignments (planMembershipChange), authorizes each resulting
 * change, and returns { dry_run: true, plan: { changes, noops }, denied } - performing
 * NO write. Out-of-policy items surface in `denied` rather than failing the request.
 *
 * Kept OUTSIDE the loop writeScope (src/supabase/**, wrangler.jsonc).
 */

import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { registerSupabaseToken, createSupabaseKey, cleanupCreatedResources } from './helpers';
import { makePolicy, allowStmt } from './policy-helpers';

const SB_API = 'https://api.supabase.com';
const SLUG = 'acme-org';
const ORG = `org:${SLUG}`;
const REF = 'dewddkcmwrzbpynylyhg';

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
	return cleanupCreatedResources();
});

function mockList(members: Array<{ email: string; role_name: string }>) {
	fetchMock
		.get(SB_API)
		.intercept({ path: `/v1/organizations/${SLUG}/members`, method: 'GET' })
		.reply(
			200,
			JSON.stringify(
				members.map((m, i) => ({ user_id: `u${i}`, user_name: m.email, email: m.email, role_name: m.role_name, mfa_enabled: false })),
			),
			{
				headers: { 'Content-Type': 'application/json' },
			},
		);
}

function dryRun(keyId: string, body: unknown) {
	return SELF.fetch(`https://gk/supabase/members/${SLUG}/invitations?dry_run=true`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('POST /supabase/members/:slug/invitations?dry_run=true', () => {
	it('returns a 200 preview with an add change and no write, when the invitee is new', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(makePolicy(allowStmt(['supabase:members:invite', 'supabase:members:update_role'], [ORG])), tid);
		mockList([]);

		const res = await dryRun(key, { users: [{ email: 'new@corp.io', role: 'Developer', project_refs: ['proj-a'] }] });
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.dry_run).toBe(true);
		expect(body.plan.changes).toHaveLength(1);
		expect(body.plan.changes[0].kind).toBe('add');
		expect(body.denied).toHaveLength(0);
	});

	it('diffs against current membership (role change becomes update_role)', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(makePolicy(allowStmt(['supabase:members:invite', 'supabase:members:update_role'], [ORG])), tid);
		mockList([{ email: 'bump@corp.io', role_name: 'Read-Only' }]);

		const res = await dryRun(key, { users: [{ email: 'bump@corp.io', role: 'Developer' }] });
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.plan.changes[0].kind).toBe('update_role');
		expect(body.plan.changes[0].fromRole).toBe('Read-Only');
		expect(body.plan.changes[0].toRole).toBe('Developer');
	});

	it('surfaces an out-of-policy change in `denied` (still 200, no write)', async () => {
		const tid = await registerSupabaseToken([REF]);
		// Key may only invite Developer/Read-Only - an Owner invite must be flagged, not applied.
		const key = await createSupabaseKey(
			makePolicy(
				allowStmt(
					['supabase:members:invite'],
					[ORG],
					[{ field: 'supabase.requested_role', operator: 'in', value: ['Developer', 'Read-Only'] }],
				),
			),
			tid,
		);
		mockList([]);

		const res = await dryRun(key, { users: [{ email: 'boss@corp.io', role: 'Owner' }] });
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.dry_run).toBe(true);
		expect(body.denied.length).toBeGreaterThan(0);
	});
});
