/**
 * Supabase membership-provisioning request body schema.
 *
 * Parses a transport-agnostic membership request into a flat list of per-assignment
 * grants. One user with N project_refs expands into N assignments; a user with no
 * project_refs yields a single org-scoped assignment (requestedProject = null).
 *
 * zod validates the boundary shape; role normalization + email parsing + duplicate
 * rejection happen after the shape is known-good.
 */

import { z } from 'zod';

export type MemberRole = 'Owner' | 'Administrator' | 'Developer' | 'Read-Only';

export interface MemberAssignment {
	targetEmail: string;
	targetDomain: string;
	requestedRole: MemberRole;
	requestedProject: string | null;
}

// Canonical role names keyed by their lowercased form for case-insensitive normalization.
const CANONICAL_ROLES: Record<string, MemberRole> = {
	owner: 'Owner',
	administrator: 'Administrator',
	developer: 'Developer',
	'read-only': 'Read-Only',
};

const userSchema = z.object({
	email: z.string(),
	role: z.string(),
	project_refs: z.array(z.string()).optional(),
});

const bodySchema = z.object({
	users: z.array(userSchema).min(1),
});

/** Split an email into a lowercased domain, throwing on a malformed address. */
function domainOf(email: string): string {
	const at = email.indexOf('@');
	if (at <= 0 || at !== email.lastIndexOf('@')) throw new Error(`malformed email: ${email}`);
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	if (!local || !domain) throw new Error(`malformed email: ${email}`);
	return domain.toLowerCase();
}

/** Normalize a role case-insensitively to its canonical name, throwing on an unknown role. */
function normalizeRole(role: string): MemberRole {
	const canonical = CANONICAL_ROLES[role.toLowerCase()];
	if (!canonical) throw new Error(`unknown role: ${role}`);
	return canonical;
}

/** Parse a membership request body into a flat, de-duplicated list of assignments. */
export function parseMemberRequest(body: unknown): MemberAssignment[] {
	const parsed = bodySchema.parse(body);

	const assignments: MemberAssignment[] = [];
	const seen = new Set<string>();

	for (const user of parsed.users) {
		const targetEmail = user.email;
		const targetDomain = domainOf(targetEmail);
		const requestedRole = normalizeRole(user.role);
		const refs = user.project_refs && user.project_refs.length > 0 ? user.project_refs : [null];

		for (const requestedProject of refs) {
			const key = `${targetEmail}\u0000${requestedRole}\u0000${requestedProject ?? ''}`;
			if (seen.has(key)) throw new Error(`duplicate assignment: ${targetEmail} ${requestedRole} ${requestedProject ?? '(org)'}`);
			seen.add(key);
			assignments.push({ targetEmail, targetDomain, requestedRole, requestedProject });
		}
	}

	return assignments;
}
