/**
 * CONFORMANCE SUITE for the pure dry-run planner (plan Section 4, planning layer).
 *
 * planMembershipChange diffs a set of requested assignments against the CURRENT
 * organization membership and classifies each into add / update_role / noop. It is
 * PURE - current state is injected (the router fetches it via the List endpoint, which
 * works upstream today) - so the diff is deterministic and testable without any network.
 *
 * Execution, idempotent apply, and before/after audit are DEFERRED to Task 0 (they need
 * the upstream write transport). This planner is the preview half and stands alone.
 *
 * Kept OUTSIDE the loop writeScope (src/supabase/**).
 */

import { describe, it, expect } from 'vitest';
import { planMembershipChange, type CurrentMember } from '../src/supabase/member-plan';
import type { MemberAssignment } from '../src/supabase/member-schema';

const asg = (email: string, role: MemberAssignment['requestedRole'], project: string | null = null): MemberAssignment => ({
	targetEmail: email,
	targetDomain: email.slice(email.indexOf('@') + 1),
	requestedRole: role,
	requestedProject: project,
});

const cur = (email: string, role: CurrentMember['role']): CurrentMember => ({ email, role });

describe('planMembershipChange', () => {
	it('classifies a not-yet-member as an add (action supabase:members:invite)', () => {
		const plan = planMembershipChange([], [asg('new@corp.io', 'Developer', 'proj-a')]);
		expect(plan.noops).toHaveLength(0);
		expect(plan.changes).toHaveLength(1);
		expect(plan.changes[0]).toMatchObject({
			kind: 'add',
			targetEmail: 'new@corp.io',
			fromRole: null,
			toRole: 'Developer',
			requestedProject: 'proj-a',
			action: 'supabase:members:invite',
		});
	});

	it('classifies a member already at the requested role as a noop', () => {
		const plan = planMembershipChange([cur('a@corp.io', 'Developer')], [asg('a@corp.io', 'Developer')]);
		expect(plan.changes).toHaveLength(0);
		expect(plan.noops).toHaveLength(1);
		expect(plan.noops[0]).toMatchObject({ kind: 'noop', targetEmail: 'a@corp.io', toRole: 'Developer' });
	});

	it('classifies a role change as update_role with from/to (action supabase:members:update_role)', () => {
		const plan = planMembershipChange([cur('a@corp.io', 'Read-Only')], [asg('a@corp.io', 'Developer')]);
		expect(plan.changes).toHaveLength(1);
		expect(plan.changes[0]).toMatchObject({
			kind: 'update_role',
			targetEmail: 'a@corp.io',
			fromRole: 'Read-Only',
			toRole: 'Developer',
			action: 'supabase:members:update_role',
		});
	});

	it('matches an existing member case-insensitively on email', () => {
		const plan = planMembershipChange([cur('Alice@Corp.IO', 'Developer')], [asg('alice@corp.io', 'Developer')]);
		expect(plan.changes).toHaveLength(0);
		expect(plan.noops).toHaveLength(1);
	});

	it('handles a mixed batch (add + update + noop)', () => {
		const plan = planMembershipChange(
			[cur('keep@corp.io', 'Developer'), cur('bump@corp.io', 'Read-Only')],
			[asg('new@corp.io', 'Developer'), asg('bump@corp.io', 'Developer'), asg('keep@corp.io', 'Developer')],
		);
		expect(plan.changes.filter((c) => c.kind === 'add')).toHaveLength(1);
		expect(plan.changes.filter((c) => c.kind === 'update_role')).toHaveLength(1);
		expect(plan.noops).toHaveLength(1);
	});
});
