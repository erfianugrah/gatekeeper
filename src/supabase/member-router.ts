/**
 * Gatekeeper-owned member-write surface.
 *
 * Exposes a stable membership-provisioning route independent of Supabase's internal/undocumented
 * write transport (deferred to plan Task 0):
 *
 *   POST /supabase/members/:slug/invitations   body { users: [ { email, role, project_refs? } ] }
 *
 * The full body-authorization pipeline runs now - coarse action/resource gate, body parse, then
 * PER-ASSIGNMENT authorization (the batch is rejected whole if any item is out of policy) - and
 * then returns 501 for the actual upstream write because the transport is not yet resolved.
 */

import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { AUDIT_CREATED_BY_API_KEY } from '../constants';
import type { RequestContext } from '../policy-types';
import { extractBearerKey, sbJsonError, proxyToManagementApi } from './proxy-helpers';
import { parseMemberRequest, normalizeRoleLenient } from './member-schema';
import { buildMemberContexts } from './member-context';
import { planMembershipChange, type CurrentMember } from './member-plan';
import { logMembershipEvents, type SupabaseMembershipEvent } from './membership-analytics';

type SupabaseEnv = { Bindings: Env };

export const memberApp = new Hono<SupabaseEnv>();

/** Map an AuthResult error to the right HTTP status (invalid key -> 401, otherwise 403). */
function authErrorStatus(error: string | undefined): number {
	return error === 'Invalid API key' ? 401 : 403;
}

// ─── Membership invitations ─────────────────────────────────────────────────
// Mounted before the /v1 and /v0 Management API catch-alls.

memberApp.post('/:slug/invitations', async (c) => {
	const start = Date.now();
	const env = c.env;
	const slug = c.req.param('slug');
	const resource = `org:${slug}`;
	const log: Record<string, unknown> = { route: 'supabase-members-invite', slug, ts: new Date().toISOString() };

	// 1. Bearer key required.
	const keyId = extractBearerKey(c.req.header('Authorization'));
	if (!keyId) {
		log.breadcrumb = 'supabase-members-invite-no-key';
		log.status = 401;
		console.log(JSON.stringify(log));
		return sbJsonError(401, 'Missing or invalid Authorization: Bearer <key>');
	}

	const stub = getStub(env);
	const rf = extractRequestFields(c.req.raw);

	// 2. COARSE authorize: gate the action/resource before the body is parsed so invalid or
	// unauthorized keys are rejected without leaking body-parse behavior.
	const coarseCtx: RequestContext = {
		action: 'supabase:members:invite',
		resource,
		fields: rf,
	};
	const coarse = await stub.authorize(keyId, '', [coarseCtx]);
	if (!coarse.authorized) {
		const status = authErrorStatus(coarse.error);
		log.breadcrumb = 'supabase-members-invite-authz-denied';
		log.status = status;
		log.authError = coarse.error;
		console.log(JSON.stringify(log));
		return sbJsonError(status, coarse.error ?? 'Forbidden');
	}

	// 3. Parse + normalize the body into per-assignment grants.
	let assignments;
	try {
		assignments = parseMemberRequest(await c.req.json());
	} catch (e: any) {
		log.breadcrumb = 'supabase-members-invite-bad-body';
		log.status = 400;
		log.error = e?.message;
		console.log(JSON.stringify(log));
		return sbJsonError(400, e?.message ?? 'Invalid request body');
	}

	// 3b. DRY-RUN preview branch: diff against current membership, authorize each planned change,
	// and return a 200 preview - NO write, NO 501. Out-of-policy items surface in `denied`.
	if (c.req.query('dry_run') === 'true') {
		const pat = coarse.upstreamTokenId ? await stub.resolveUpstreamTokenById(coarse.upstreamTokenId) : null;
		if (!pat) {
			log.breadcrumb = coarse.upstreamTokenId ? 'supabase-members-invite-pinned-pat-not-found' : 'supabase-members-invite-pat-not-found';
			log.status = 502;
			console.log(JSON.stringify(log));
			return sbJsonError(
				502,
				coarse.upstreamTokenId
					? `Pinned upstream token ${coarse.upstreamTokenId} not found`
					: 'No Supabase Personal Access Token registered for this organization',
			);
		}

		// Fetch CURRENT membership via the (upstream-supported) List endpoint.
		const listRes = await proxyToManagementApi(`/v1/organizations/${slug}/members`, pat, 'GET');
		const listBody = (await listRes.json().catch(() => [])) as Array<{ email?: string; role_name?: string }>;
		const current: CurrentMember[] = [];
		for (const entry of Array.isArray(listBody) ? listBody : []) {
			if (!entry || typeof entry.email !== 'string' || typeof entry.role_name !== 'string') continue;
			const role = normalizeRoleLenient(entry.role_name);
			if (!role) continue; // skip members whose role does not normalize
			current.push({ email: entry.email, role });
		}

		const plan = planMembershipChange(current, assignments);

		// Authorize each planned change; collect denials but do NOT fail the request.
		const denied: string[] = [];
		const deniedIdx = new Set<number>();
		for (const [idx, change] of plan.changes.entries()) {
			const fields: Record<string, string> = {
				'supabase.requested_role': change.toRole,
				'supabase.target_email': change.targetEmail,
				'supabase.batch_size': String(plan.changes.length),
			};
			if (change.requestedProject !== null) fields['supabase.requested_project'] = change.requestedProject;
			const ctx: RequestContext = { action: change.action, resource, fields };
			const decision = await stub.authorize(keyId, '', [ctx]);
			if (!decision.authorized) {
				deniedIdx.add(idx);
				denied.push(`${change.action} ${change.targetEmail} -> ${change.toRole}: ${decision.error ?? 'Forbidden'}`);
			}
		}

		// Audit (plan Task 5): one row per planned change (preview | denied) and per noop,
		// so the before/after INTENT stays on record even though no upstream write exists.
		if (env.ANALYTICS_DB) {
			const createdBy = coarse.keyName ? `key:${coarse.keyName}` : AUDIT_CREATED_BY_API_KEY;
			const idemKey = c.req.header('Idempotency-Key') ?? null;
			const now = Date.now();
			const auditRows: SupabaseMembershipEvent[] = [
				...plan.changes.map((change, idx) => ({
					key_id: keyId,
					org_slug: slug,
					action: change.action,
					target_email: change.targetEmail,
					from_role: change.fromRole,
					requested_role: change.toRole,
					resulting_role: null,
					outcome: (deniedIdx.has(idx) ? 'denied' : 'preview') as SupabaseMembershipEvent['outcome'],
					idempotency_key: idemKey,
					reconcile_status: null,
					detail: null,
					created_by: createdBy,
					created_at: now,
				})),
				...plan.noops.map((noop) => ({
					key_id: keyId,
					org_slug: slug,
					action: noop.action,
					target_email: noop.targetEmail,
					from_role: noop.fromRole,
					requested_role: noop.toRole,
					resulting_role: null,
					outcome: 'noop' as const,
					idempotency_key: idemKey,
					reconcile_status: null,
					detail: null,
					created_by: createdBy,
					created_at: now,
				})),
			];
			c.executionCtx.waitUntil(logMembershipEvents(env.ANALYTICS_DB, auditRows));
		}

		log.breadcrumb = 'supabase-members-invite-dry-run';
		log.status = 200;
		log.changes = plan.changes.length;
		log.noops = plan.noops.length;
		log.denied = denied.length;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return new Response(JSON.stringify({ dry_run: true, plan, denied }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// 4. FINE authorize: one context per assignment. evaluatePolicy ANDs all contexts, so a single
	// out-of-policy item rejects the whole batch.
	const contexts = buildMemberContexts('supabase:members:invite', assignments, resource);
	const fine = await stub.authorize(keyId, '', contexts);
	if (!fine.authorized) {
		log.breadcrumb = 'supabase-members-invite-authz-denied';
		log.status = 403;
		log.authError = fine.error;
		console.log(JSON.stringify(log));
		return sbJsonError(403, fine.error ?? 'Forbidden');
	}

	// 5. Account-level Supabase rate limit - shared across all Supabase proxy calls.
	const rl = await stub.consumeSupabaseRateLimit();
	if (!rl.allowed) {
		log.breadcrumb = 'supabase-members-invite-rate-limited';
		log.status = 429;
		log.error = 'rate_limited';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return sbJsonError(429, 'Rate limit exceeded', { 'Retry-After': String(rl.retryAfterSec) });
	}

	// 6. Upstream write transport is not yet resolved (plan Task 0) - everything up to this point
	// is real and testable; only the final upstream hop is stubbed.
	// Audit the blocked attempt: one row per assignment (from_role unknown - the execute path
	// does not fetch current membership).
	if (env.ANALYTICS_DB) {
		const createdBy = (fine.keyName ?? coarse.keyName) ? `key:${fine.keyName ?? coarse.keyName}` : AUDIT_CREATED_BY_API_KEY;
		const idemKey = c.req.header('Idempotency-Key') ?? null;
		const now = Date.now();
		const auditRows: SupabaseMembershipEvent[] = assignments.map((asg) => ({
			key_id: keyId,
			org_slug: slug,
			action: 'supabase:members:invite',
			target_email: asg.targetEmail,
			from_role: null,
			requested_role: asg.requestedRole,
			resulting_role: null,
			outcome: 'blocked',
			idempotency_key: idemKey,
			reconcile_status: null,
			detail: 'member-write transport is not PAT-drivable (plan Task 0)',
			created_by: createdBy,
			created_at: now,
		}));
		c.executionCtx.waitUntil(logMembershipEvents(env.ANALYTICS_DB, auditRows));
	}
	log.breadcrumb = 'supabase-members-invite-upstream-pending';
	log.status = 501;
	log.assignments = assignments.length;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));
	return sbJsonError(501, 'Supabase member-write transport is not yet wired (see plan Task 0)');
});
