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
import type { RequestContext } from '../policy-types';
import { extractBearerKey, sbJsonError, proxyToManagementApi } from './proxy-helpers';
import { parseMemberRequest, normalizeRoleLenient } from './member-schema';
import { buildMemberContexts } from './member-context';
import { planMembershipChange, type CurrentMember } from './member-plan';

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
		for (const change of plan.changes) {
			const fields: Record<string, string> = {
				'supabase.requested_role': change.toRole,
				'supabase.target_email': change.targetEmail,
				'supabase.batch_size': String(plan.changes.length),
			};
			if (change.requestedProject !== null) fields['supabase.requested_project'] = change.requestedProject;
			const ctx: RequestContext = { action: change.action, resource, fields };
			const decision = await stub.authorize(keyId, '', [ctx]);
			if (!decision.authorized) {
				denied.push(`${change.action} ${change.targetEmail} -> ${change.toRole}: ${decision.error ?? 'Forbidden'}`);
			}
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
	log.breadcrumb = 'supabase-members-invite-upstream-pending';
	log.status = 501;
	log.assignments = assignments.length;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));
	return sbJsonError(501, 'Supabase member-write transport is not yet wired (see plan Task 0)');
});
