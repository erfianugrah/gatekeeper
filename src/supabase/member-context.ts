/**
 * Builds one RequestContext per membership assignment so the existing policy engine
 * can authorize a batch: evaluatePolicy ANDs all contexts, so a batch is rejected
 * whole if any single assignment is impermissible.
 *
 * Fields are scalar (string | boolean) - one context carries the body-derived facts
 * for exactly one (email, role, project) grant. requested_project is OMITTED for
 * org-scoped assignments so project conditions are vacuous on allow.
 */

import type { RequestContext } from '../policy-types';
import type { MemberAssignment } from './member-schema';

/** Build per-assignment request contexts for a membership action. */
export function buildMemberContexts(
	action: string,
	assignments: MemberAssignment[],
	resource: string,
	opts?: { productionRefs?: string[] },
): RequestContext[] {
	const productionRefs = new Set(opts?.productionRefs ?? []);
	const batchSize = String(assignments.length);

	return assignments.map((a) => {
		const fields: Record<string, string | boolean> = {
			'supabase.target_email': a.targetEmail,
			'supabase.target_domain': a.targetDomain,
			'supabase.requested_role': a.requestedRole,
			'supabase.batch_size': batchSize,
			'supabase.contains_production': a.requestedProject !== null && productionRefs.has(a.requestedProject),
		};
		if (a.requestedProject !== null) {
			fields['supabase.requested_project'] = a.requestedProject;
		}
		return { action, resource, fields };
	});
}
