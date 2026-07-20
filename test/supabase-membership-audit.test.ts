/**
 * CONFORMANCE SUITE for the membership audit trail (plan Task 5).
 *
 * Every membership-domain decision on the invitations surface writes a row to
 * `supabase_membership_events` in D1:
 *
 *   - dry-run preview: one row per planned change (outcome 'preview' or 'denied')
 *     and per noop (outcome 'noop'), carrying from_role / requested_role so the
 *     before/after intent is auditable even though no upstream write exists.
 *   - execute attempt (currently 501 - member writes are not PAT-drivable): one
 *     row per assignment with outcome 'blocked'.
 *   - coarse authz failures (401/403) write NO rows (nothing was planned).
 *
 * Admin read surface follows the sibling convention:
 *   GET /admin/supabase/membership/{events,summary,timeseries}
 */

import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { registerSupabaseToken, createSupabaseKey, cleanupCreatedResources, adminHeaders, waitForAnalytics } from './helpers';
import { makePolicy, allowStmt } from './policy-helpers';

const SB_API = 'https://api.supabase.com';
const REF = 'dewddkcmwrzbpynylyhg';

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
	return cleanupCreatedResources();
});

function mockList(slug: string, members: Array<{ email: string; role_name: string }>) {
	fetchMock
		.get(SB_API)
		.intercept({ path: `/v1/organizations/${slug}/members`, method: 'GET' })
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

function dryRun(slug: string, keyId: string, body: unknown) {
	return SELF.fetch(`https://gk/supabase/members/${slug}/invitations?dry_run=true`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

function execute(slug: string, keyId: string, body: unknown) {
	return SELF.fetch(`https://gk/supabase/members/${slug}/invitations`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function membershipEvents(slug: string): Promise<any[]> {
	const res = await SELF.fetch(`https://gk/admin/supabase/membership/events?org_slug=${slug}`, { headers: adminHeaders() });
	expect(res.status).toBe(200);
	const data = await res.json<any>();
	return Array.isArray(data.result) ? data.result : [];
}

describe('membership audit - dry-run preview', () => {
	it('writes one row per planned change and per noop, with before/requested roles', async () => {
		const slug = 'audit-preview';
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(
			makePolicy(allowStmt(['supabase:members:invite', 'supabase:members:update_role'], [`org:${slug}`])),
			tid,
		);
		mockList(slug, [
			{ email: 'stay@corp.io', role_name: 'Developer' },
			{ email: 'bump@corp.io', role_name: 'Read-Only' },
		]);

		const res = await dryRun(slug, key, {
			users: [
				{ email: 'stay@corp.io', role: 'Developer' }, // noop
				{ email: 'bump@corp.io', role: 'Developer' }, // update_role
				{ email: 'new@corp.io', role: 'Read-Only' }, // add
			],
		});
		expect(res.status).toBe(200);
		await waitForAnalytics();

		const rows = await membershipEvents(slug);
		expect(rows).toHaveLength(3);

		const byEmail = new Map<string, any>(rows.map((r: any) => [r.target_email, r]));

		const add = byEmail.get('new@corp.io');
		expect(add.action).toBe('supabase:members:invite');
		expect(add.outcome).toBe('preview');
		expect(add.from_role).toBeNull();
		expect(add.requested_role).toBe('Read-Only');
		expect(add.org_slug).toBe(slug);

		const update = byEmail.get('bump@corp.io');
		expect(update.action).toBe('supabase:members:update_role');
		expect(update.outcome).toBe('preview');
		expect(update.from_role).toBe('Read-Only');
		expect(update.requested_role).toBe('Developer');

		const noop = byEmail.get('stay@corp.io');
		expect(noop.outcome).toBe('noop');
		expect(noop.from_role).toBe('Developer');
		expect(noop.requested_role).toBe('Developer');

		// Actor identity: the key, not a person (plan Task 5 actor limitation).
		for (const row of rows) {
			expect(typeof row.created_by).toBe('string');
			expect(row.created_by).toMatch(/^key:/);
		}
	});

	it('audits an out-of-policy change with outcome denied', async () => {
		const slug = 'audit-denied';
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(
			makePolicy(
				allowStmt(
					['supabase:members:invite'],
					[`org:${slug}`],
					[{ field: 'supabase.requested_role', operator: 'in', value: ['Developer', 'Read-Only'] }],
				),
			),
			tid,
		);
		mockList(slug, []);

		const res = await dryRun(slug, key, { users: [{ email: 'boss@corp.io', role: 'Owner' }] });
		expect(res.status).toBe(200);
		await waitForAnalytics();

		const rows = await membershipEvents(slug);
		expect(rows).toHaveLength(1);
		expect(rows[0].outcome).toBe('denied');
		expect(rows[0].requested_role).toBe('Owner');
		expect(rows[0].target_email).toBe('boss@corp.io');
	});
});

describe('membership audit - execute attempt (501, transport not PAT-drivable)', () => {
	it('writes one blocked row per assignment', async () => {
		const slug = 'audit-blocked';
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(makePolicy(allowStmt(['supabase:members:invite'], [`org:${slug}`])), tid);

		const res = await execute(slug, key, {
			users: [
				{ email: 'a@corp.io', role: 'Developer' },
				{ email: 'b@corp.io', role: 'Read-Only' },
			],
		});
		expect(res.status).toBe(501);
		await waitForAnalytics();

		const rows = await membershipEvents(slug);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.outcome).toBe('blocked');
			expect(row.action).toBe('supabase:members:invite');
			expect(row.resulting_role).toBeNull();
		}
	});
});

describe('membership audit - authz failures write nothing', () => {
	it('a coarse-authz denial (403) produces no audit rows', async () => {
		const slug = 'audit-forbidden';
		const tid = await registerSupabaseToken([REF]);
		// Key may only LIST members - invite is denied at the coarse gate.
		const key = await createSupabaseKey(makePolicy(allowStmt(['supabase:members:list'], [`org:${slug}`])), tid);

		const res = await dryRun(slug, key, { users: [{ email: 'x@corp.io', role: 'Developer' }] });
		expect(res.status).toBe(403);
		await waitForAnalytics();

		expect(await membershipEvents(slug)).toHaveLength(0);
	});
});

describe('membership audit - admin read surface', () => {
	it('summary aggregates by outcome and action; timeseries buckets', async () => {
		const slug = 'audit-summary';
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(
			makePolicy(allowStmt(['supabase:members:invite', 'supabase:members:update_role'], [`org:${slug}`])),
			tid,
		);
		mockList(slug, [{ email: 'bump@corp.io', role_name: 'Read-Only' }]);

		const res = await dryRun(slug, key, {
			users: [
				{ email: 'bump@corp.io', role: 'Developer' },
				{ email: 'new@corp.io', role: 'Developer' },
			],
		});
		expect(res.status).toBe(200);
		await waitForAnalytics();

		const summaryRes = await SELF.fetch(`https://gk/admin/supabase/membership/summary?org_slug=${slug}`, { headers: adminHeaders() });
		expect(summaryRes.status).toBe(200);
		const summary = (await summaryRes.json<any>()).result;
		expect(summary.total_events).toBe(2);
		expect(summary.by_outcome['preview']).toBe(2);
		expect(summary.by_action['supabase:members:invite']).toBe(1);
		expect(summary.by_action['supabase:members:update_role']).toBe(1);

		const tsRes = await SELF.fetch(`https://gk/admin/supabase/membership/timeseries?org_slug=${slug}`, { headers: adminHeaders() });
		expect(tsRes.status).toBe(200);
		expect(Array.isArray((await tsRes.json<any>()).result)).toBe(true);
	});
});
