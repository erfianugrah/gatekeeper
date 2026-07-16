/**
 * Pure membership-change planner (plan Section 4, preview layer).
 *
 * Diffs a set of requested assignments against the CURRENT organization membership and
 * classifies each into add / update_role / noop. State is INJECTED (the router fetches it
 * via the Supabase List endpoint), so the diff is deterministic and testable with no network.
 *
 * Execution / idempotent apply / before-after audit are deferred to plan Task 0 (they need the
 * upstream write transport). This planner is the preview half and stands alone.
 */

import type { MemberRole, MemberAssignment } from './member-schema';

export interface CurrentMember {
	email: string;
	role: MemberRole;
}

export type PlannedChangeKind = 'add' | 'update_role' | 'noop';

export interface PlannedChange {
	kind: PlannedChangeKind;
	targetEmail: string;
	fromRole: MemberRole | null;
	toRole: MemberRole;
	requestedProject: string | null;
	action: string;
}

export interface MembershipPlan {
	changes: PlannedChange[];
	noops: PlannedChange[];
}

/** Diff requested assignments against current membership, classifying each change. */
export function planMembershipChange(current: CurrentMember[], assignments: MemberAssignment[]): MembershipPlan {
	const byEmail = new Map<string, CurrentMember>();
	for (const member of current) {
		byEmail.set(member.email.toLowerCase(), member);
	}

	const changes: PlannedChange[] = [];
	const noops: PlannedChange[] = [];

	for (const asg of assignments) {
		const existing = byEmail.get(asg.targetEmail.toLowerCase());

		if (!existing) {
			changes.push({
				kind: 'add',
				targetEmail: asg.targetEmail,
				fromRole: null,
				toRole: asg.requestedRole,
				requestedProject: asg.requestedProject,
				action: 'supabase:members:invite',
			});
			continue;
		}

		if (existing.role === asg.requestedRole) {
			noops.push({
				kind: 'noop',
				targetEmail: asg.targetEmail,
				fromRole: existing.role,
				toRole: asg.requestedRole,
				requestedProject: asg.requestedProject,
				action: 'supabase:members:update_role',
			});
			continue;
		}

		changes.push({
			kind: 'update_role',
			targetEmail: asg.targetEmail,
			fromRole: existing.role,
			toRole: asg.requestedRole,
			requestedProject: asg.requestedProject,
			action: 'supabase:members:update_role',
		});
	}

	return { changes, noops };
}
