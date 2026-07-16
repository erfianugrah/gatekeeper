/**
 * CONFORMANCE SUITE for the Supabase membership-provisioning backend increment.
 *
 * This file is the SPEC. It is intentionally kept OUTSIDE the loop harness
 * writeScope (which is `src/supabase/**`) so the implementing agent cannot
 * weaken it to force a green - it can only make the implementation satisfy it.
 *
 * Scope (transport-agnostic, pure - no Durable Object, no network):
 *   1. classify.ts       - GET /v1/organizations/{slug}/members -> supabase:members:list
 *   2. member-schema.ts  - parseMemberRequest(body) -> flat MemberAssignment[]
 *   3. member-context.ts - buildMemberContexts(action, assignments, resource, opts) -> RequestContext[]
 *                          integrated with the REAL evaluatePolicy so a batch is
 *                          rejected whole if any single assignment is impermissible.
 *
 * Upstream write endpoints (invite/re-role/remove) are internal + unstable and are
 * DEFERRED to the plan's Task 0 - this suite deliberately asserts that a POST to the
 * members path is NOT classified as a member write.
 */

import { describe, it, expect } from 'vitest';
import { classifySupabaseRequest } from '../src/supabase/classify';
import { parseMemberRequest, type MemberAssignment } from '../src/supabase/member-schema';
import { buildMemberContexts } from '../src/supabase/member-context';
import { evaluatePolicy } from '../src/policy-engine';
import { makePolicy, allowStmt, denyStmt } from './policy-helpers';

const SLUG = 'acme';
const ORG = `org:${SLUG}`;

// ─── 1. Classifier ──────────────────────────────────────────────────────────

describe('classifySupabaseRequest - members', () => {
	it('classifies GET /v1/organizations/{slug}/members as supabase:members:list', () => {
		const r = classifySupabaseRequest('GET', `/v1/organizations/${SLUG}/members`);
		expect(r).toEqual({
			action: 'supabase:members:list',
			category: 'members',
			write: false,
			projectRef: null,
			resource: ORG,
		});
	});

	it('leaves the org root path on the organizations category (unchanged)', () => {
		const r = classifySupabaseRequest('GET', `/v1/organizations/${SLUG}`);
		expect(r?.category).toBe('organizations');
		expect(r?.action).toBe('supabase:organizations:read');
	});

	it('does NOT classify POST to the members path as a member write (write transport is deferred)', () => {
		const r = classifySupabaseRequest('POST', `/v1/organizations/${SLUG}/members`);
		// Falls through to the generic organizations mapping - must not invent a members:invite
		// route on a public endpoint that does not exist.
		expect(r?.category).not.toBe('members');
	});
});

// ─── 2. Body schema ───────────────────────────────────────────────────────────
//
// Input contract:  { users: [ { email: string, role: string, project_refs?: string[] } ] }
//   - one assignment per (user, project_ref); missing/empty project_refs -> one
//     assignment with requestedProject = null (org-scoped).
//   - role normalized case-insensitively to one of Owner|Administrator|Developer|Read-Only.
//   - email must contain a non-empty local part and domain.
//   - an exact duplicate assignment (same email+role+project) is rejected.

describe('parseMemberRequest', () => {
	it('expands one user with N project_refs into N assignments', () => {
		const out = parseMemberRequest({
			users: [{ email: 'person@example.com', role: 'Developer', project_refs: ['proj-a', 'proj-b'] }],
		});
		expect(out).toHaveLength(2);
		expect(out.map((a) => a.requestedProject)).toEqual(['proj-a', 'proj-b']);
		expect(out.every((a) => a.requestedRole === 'Developer')).toBe(true);
		expect(out.every((a) => a.targetEmail === 'person@example.com')).toBe(true);
		expect(out.every((a) => a.targetDomain === 'example.com')).toBe(true);
	});

	it('produces a single org-scoped assignment when project_refs is absent', () => {
		const out = parseMemberRequest({ users: [{ email: 'a@corp.io', role: 'Read-Only' }] });
		expect(out).toHaveLength(1);
		expect(out[0].requestedProject).toBeNull();
		expect(out[0].requestedRole).toBe('Read-Only');
		expect(out[0].targetDomain).toBe('corp.io');
	});

	it('normalizes role case-insensitively to the canonical name', () => {
		expect(parseMemberRequest({ users: [{ email: 'a@x.io', role: 'owner' }] })[0].requestedRole).toBe('Owner');
		expect(parseMemberRequest({ users: [{ email: 'a@x.io', role: 'read-only' }] })[0].requestedRole).toBe('Read-Only');
		expect(parseMemberRequest({ users: [{ email: 'a@x.io', role: 'ADMINISTRATOR' }] })[0].requestedRole).toBe('Administrator');
	});

	it('rejects an unknown role', () => {
		expect(() => parseMemberRequest({ users: [{ email: 'a@x.io', role: 'superuser' }] })).toThrow();
	});

	it('rejects a malformed email', () => {
		expect(() => parseMemberRequest({ users: [{ email: 'notanemail', role: 'Developer' }] })).toThrow();
	});

	it('rejects an exact duplicate assignment', () => {
		expect(() =>
			parseMemberRequest({
				users: [
					{ email: 'a@x.io', role: 'Developer', project_refs: ['p1'] },
					{ email: 'a@x.io', role: 'Developer', project_refs: ['p1'] },
				],
			}),
		).toThrow();
	});

	it('rejects a body with no users', () => {
		expect(() => parseMemberRequest({ users: [] })).toThrow();
		expect(() => parseMemberRequest({})).toThrow();
	});
});

// ─── 3. Context builder ───────────────────────────────────────────────────────

const A = (over: Partial<MemberAssignment> = {}): MemberAssignment => ({
	targetEmail: 'dev@corp.io',
	targetDomain: 'corp.io',
	requestedRole: 'Developer',
	requestedProject: 'proj-a',
	...over,
});

describe('buildMemberContexts', () => {
	it('produces one context per assignment, propagating action + resource', () => {
		const ctxs = buildMemberContexts('supabase:members:invite', [A(), A({ requestedProject: 'proj-b' })], ORG);
		expect(ctxs).toHaveLength(2);
		for (const c of ctxs) {
			expect(c.action).toBe('supabase:members:invite');
			expect(c.resource).toBe(ORG);
		}
	});

	it('sets scalar body-derived fields for a project-scoped assignment', () => {
		const [c] = buildMemberContexts('supabase:members:invite', [A()], ORG);
		expect(c.fields['supabase.target_email']).toBe('dev@corp.io');
		expect(c.fields['supabase.target_domain']).toBe('corp.io');
		expect(c.fields['supabase.requested_role']).toBe('Developer');
		expect(c.fields['supabase.requested_project']).toBe('proj-a');
		expect(c.fields['supabase.batch_size']).toBe('1');
		expect(c.fields['supabase.contains_production']).toBe(false);
	});

	it('omits requested_project for an org-scoped assignment (so project conditions are vacuous on allow)', () => {
		const [c] = buildMemberContexts('supabase:members:invite', [A({ requestedProject: null })], ORG);
		expect('supabase.requested_project' in c.fields).toBe(false);
		expect(c.fields['supabase.contains_production']).toBe(false);
	});

	it('marks contains_production true when the assignment targets a production ref', () => {
		const [prod, nonprod] = buildMemberContexts(
			'supabase:members:invite',
			[A({ requestedProject: 'prod-1' }), A({ requestedProject: 'proj-a' })],
			ORG,
			{ productionRefs: ['prod-1'] },
		);
		expect(prod.fields['supabase.contains_production']).toBe(true);
		expect(nonprod.fields['supabase.contains_production']).toBe(false);
	});

	it('reports batch_size as the total assignment count on every context', () => {
		const ctxs = buildMemberContexts(
			'supabase:members:invite',
			[A(), A({ requestedProject: 'proj-b' }), A({ requestedProject: 'proj-c' })],
			ORG,
		);
		expect(ctxs.every((c) => c.fields['supabase.batch_size'] === '3')).toBe(true);
	});
});

// ─── 4. End-to-end authorization via the REAL policy engine ───────────────────

describe('membership authorization (buildMemberContexts + evaluatePolicy)', () => {
	// Allow only Developer/Read-Only invites to proj-a / proj-b.
	const policy = makePolicy(
		allowStmt(
			['supabase:members:invite'],
			[ORG],
			[
				{ field: 'supabase.requested_role', operator: 'in', value: ['Developer', 'Read-Only'] },
				{ field: 'supabase.requested_project', operator: 'in', value: ['proj-a', 'proj-b'] },
			],
		),
	);

	const auth = (assignments: MemberAssignment[]) =>
		evaluatePolicy(policy, buildMemberContexts('supabase:members:invite', assignments, ORG));

	it('allows an in-policy invite (Developer -> proj-a)', () => {
		expect(auth([A()])).toBe(true);
	});

	it('denies an over-privileged role (Owner -> proj-a)', () => {
		expect(auth([A({ requestedRole: 'Owner' })])).toBe(false);
	});

	it('denies an out-of-scope project (Developer -> proj-c)', () => {
		expect(auth([A({ requestedProject: 'proj-c' })])).toBe(false);
	});

	it('rejects the WHOLE batch when a single assignment is impermissible', () => {
		const good = A();
		const bad = A({ requestedRole: 'Owner', requestedProject: 'proj-b' });
		expect(auth([good, bad])).toBe(false);
	});

	it('allows a batch where every assignment is in policy', () => {
		expect(auth([A(), A({ requestedRole: 'Read-Only', requestedProject: 'proj-b' })])).toBe(true);
	});

	it('a deny on contains_production blocks an otherwise-allowed production invite', () => {
		const guarded = makePolicy(
			allowStmt(
				['supabase:members:invite'],
				[ORG],
				[{ field: 'supabase.requested_role', operator: 'in', value: ['Developer', 'Read-Only'] }],
			),
			denyStmt(['supabase:members:*'], [ORG], [{ field: 'supabase.contains_production', operator: 'eq', value: true }]),
		);
		const ctxs = buildMemberContexts('supabase:members:invite', [A({ requestedProject: 'prod-1' })], ORG, { productionRefs: ['prod-1'] });
		expect(evaluatePolicy(guarded, ctxs)).toBe(false);
	});
});
