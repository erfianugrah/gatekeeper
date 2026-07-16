/**
 * CONFORMANCE SUITE for the membership-invitations route (plan Section 3).
 *
 * Gatekeeper exposes its OWN stable member-write surface (independent of Supabase's
 * internal/undocumented write transport, which is deferred to plan Task 0):
 *
 *   POST /supabase/members/:slug/invitations   body { users: [ { email, role, project_refs? } ] }
 *
 * The handler runs the full body-authorization pipeline - coarse action/resource gate,
 * body parse, then PER-ASSIGNMENT authorization (a batch is rejected whole if any item
 * is out of policy) - and then returns 501 for the actual upstream write because the
 * transport is not yet resolved. Auth, body-inspection, and batch-rejection are real and
 * testable now; only the final upstream hop is stubbed.
 *
 * Kept OUTSIDE the loop writeScope (src/supabase/**, wrangler.jsonc) so it cannot be weakened.
 */

import { SELF } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { registerSupabaseToken, createSupabaseKey, cleanupCreatedResources } from './helpers';
import { makePolicy, allowStmt } from './policy-helpers';

const SLUG = 'acme-org';
const ORG = `org:${SLUG}`;
const REF = 'dewddkcmwrzbpynylyhg';

function invite(keyId: string | null, body: unknown) {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (keyId) headers.Authorization = `Bearer ${keyId}`;
	return SELF.fetch(`http://localhost/supabase/members/${SLUG}/invitations`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
}

const VALID_INVITE = { users: [{ email: 'dev@corp.io', role: 'Developer', project_refs: ['proj-a'] }] };

describe('POST /supabase/members/:slug/invitations', () => {
	afterEach(() => cleanupCreatedResources());

	it('401 when no bearer key is presented', async () => {
		const res = await invite(null, VALID_INVITE);
		expect(res.status).toBe(401);
	});

	it('403 when the key is not authorized to invite on this org', async () => {
		const tid = await registerSupabaseToken([REF]);
		// Key can invite, but only on a different org.
		const key = await createSupabaseKey(makePolicy(allowStmt(['supabase:members:invite'], ['org:other-org'])), tid);
		const res = await invite(key, VALID_INVITE);
		expect(res.status).toBe(403);
	});

	it('501 (authorized; upstream transport deferred) for an in-policy invite', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(makePolicy(allowStmt(['supabase:members:invite'], [ORG])), tid);
		const res = await invite(key, VALID_INVITE);
		expect(res.status).toBe(501);
	});

	it('400 on a malformed body (unknown role) from an authorized key', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(makePolicy(allowStmt(['supabase:members:invite'], [ORG])), tid);
		const res = await invite(key, { users: [{ email: 'dev@corp.io', role: 'superuser' }] });
		expect(res.status).toBe(400);
	});

	it('403 denies an over-privileged role via a per-assignment condition', async () => {
		const tid = await registerSupabaseToken([REF]);
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
		const res = await invite(key, { users: [{ email: 'dev@corp.io', role: 'Owner' }] });
		expect(res.status).toBe(403);
	});

	it('403 rejects the WHOLE batch when a single assignment is out of policy', async () => {
		const tid = await registerSupabaseToken([REF]);
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
		const res = await invite(key, {
			users: [
				{ email: 'ok@corp.io', role: 'Developer' },
				{ email: 'bad@corp.io', role: 'Owner' },
			],
		});
		expect(res.status).toBe(403);
	});
});
