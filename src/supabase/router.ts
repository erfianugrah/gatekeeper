/**
 * Supabase proxy router.
 *
 * Two paths, both fronting a stored Supabase credential with Gatekeeper's IAM + policy engine:
 *   GET /supabase/metrics/:ref  → per-project Metrics API (HTTP Basic, secret-key swap)
 *   ALL /supabase/v1/*          → Management API (Bearer PAT swap), authorized via the classifier
 *   ALL /supabase/v0/*          → experimental Management API surface; only the analytics metrics
 *                                 scrape endpoint is mapped (see classify.ts), same PAT-swap path
 *
 * Auth happens BEFORE upstream-credential resolution so unauthenticated callers cannot probe
 * which refs have a stored credential (502 vs 401 would leak that).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { AUDIT_CREATED_BY_API_KEY } from '../constants';
import type { RequestContext } from '../policy-types';
import { classifySupabaseRequest } from './classify';
import {
	extractBearerKey,
	isValidSupabaseRef,
	sbJsonError,
	proxyToManagementApi,
	proxyToMetrics,
	buildProxyResponse,
	extractResponseDetail,
} from './proxy-helpers';
import { logSupabaseProxyEvent, type SupabaseProxyEvent } from './analytics';

type SupabaseEnv = { Bindings: Env };

export const supabaseApp = new Hono<SupabaseEnv>();

/** Map an AuthResult error to the right HTTP status (invalid key → 401, otherwise 403). */
function authErrorStatus(error: string | undefined): number {
	return error === 'Invalid API key' ? 401 : 403;
}

// ─── Metrics proxy ──────────────────────────────────────────────────────────
// Mounted before the catch-all. /v1/* would not match /metrics/:ref anyway, but order is explicit.

supabaseApp.get('/metrics/:ref', async (c) => {
	const start = Date.now();
	const env = c.env;
	const ref = c.req.param('ref');
	const log: Record<string, unknown> = { route: 'supabase-metrics', ref, ts: new Date().toISOString() };

	const keyId = extractBearerKey(c.req.header('Authorization'));
	if (!keyId) return sbJsonError(401, 'Missing or invalid Authorization: Bearer <key>');
	if (!isValidSupabaseRef(ref)) return sbJsonError(400, 'Invalid project ref');

	const rf = extractRequestFields(c.req.raw);
	const ctx: RequestContext = {
		action: 'supabase:metrics:read',
		resource: `project:${ref}`,
		fields: { ...rf, 'supabase.project_ref': ref, 'supabase.category': 'metrics', 'supabase.method': 'GET', 'supabase.write': false },
	};

	const stub = getStub(env);
	// Note: the `ref` argument to authorize() has no effect for Supabase keys (which have no
	// zone_id set). Resource scoping is enforced entirely via ctx.resource in the policy engine.
	const auth = await stub.authorize(keyId, ref, [ctx]);
	if (!auth.authorized) {
		const status = authErrorStatus(auth.error);
		log.breadcrumb = 'supabase-metrics-authz-denied';
		log.status = status;
		log.authError = auth.error;
		console.log(JSON.stringify(log));
		return sbJsonError(status, auth.error ?? 'Forbidden');
	}

	// Binding wins: a key pinned to a metrics credential uses that exact secret, never a ref match.
	const cred = auth.upstreamTokenId
		? await stub.resolveSupabaseMetricsCredentialById(auth.upstreamTokenId)
		: await stub.resolveSupabaseMetricsCredential(ref);
	if (!cred) {
		log.breadcrumb = auth.upstreamTokenId ? 'supabase-metrics-pinned-credential-not-found' : 'supabase-metrics-credential-not-found';
		log.status = 502;
		console.log(JSON.stringify(log));
		return sbJsonError(
			502,
			auth.upstreamTokenId
				? `Pinned metrics credential ${auth.upstreamTokenId} not found`
				: `No metrics credential registered for project ${ref}`,
		);
	}

	const upstreamStart = Date.now();
	const upstream = await proxyToMetrics(ref, cred.username, cred.secret);
	const upstreamLatency = Date.now() - upstreamStart;
	log.breadcrumb = 'supabase-metrics-ok';
	log.status = upstream.status;
	log.upstreamLatencyMs = upstreamLatency;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));

	if (env.ANALYTICS_DB) {
		const event: SupabaseProxyEvent = {
			key_id: keyId,
			project_ref: ref,
			category: 'metrics',
			action: 'supabase:metrics:read',
			status: upstream.status,
			upstream_status: upstream.status,
			duration_ms: Date.now() - start,
			upstream_latency_ms: upstreamLatency,
			response_size: null,
			response_detail: null,
			created_by: auth.keyName ? `key:${auth.keyName}` : AUDIT_CREATED_BY_API_KEY,
			created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logSupabaseProxyEvent(env.ANALYTICS_DB, event));
	}

	// Metrics is Prometheus text — stream the body through unchanged.
	return buildProxyResponse(upstream, null);
});

// ─── Management API catch-all ───────────────────────────────────────────────

const managementApiHandler = async (c: Context<SupabaseEnv>) => {
	const start = Date.now();
	const env = c.env;
	const method = c.req.method;
	const url = new URL(c.req.url);
	const path = url.pathname.replace(/^\/supabase/, ''); // strip mount prefix → '/v1/...'
	const log: Record<string, unknown> = { route: 'supabase-mgmt', method, path, ts: new Date().toISOString() };

	const keyId = extractBearerKey(c.req.header('Authorization'));
	if (!keyId) return sbJsonError(401, 'Missing or invalid Authorization: Bearer <key>');

	const cls = classifySupabaseRequest(method, path);
	if (!cls) {
		log.breadcrumb = 'supabase-mgmt-unmapped';
		log.status = 404;
		console.log(JSON.stringify(log));
		return sbJsonError(404, `Endpoint not mapped in Gatekeeper policy surface: ${method} ${path}`);
	}
	log.action = cls.action;
	log.projectRef = cls.projectRef;

	const rf = extractRequestFields(c.req.raw);
	const ctx: RequestContext = {
		action: cls.action,
		resource: cls.resource,
		fields: {
			...rf,
			'supabase.category': cls.category,
			'supabase.method': method,
			'supabase.write': cls.write,
			// projectRef is null for account-level endpoints (GET /v1/projects, /v1/organizations).
			// Omitting the field is intentional: the policy engine's effect-aware skip treats a
			// missing field as vacuously satisfied on allow statements, which is correct — an
			// account-level action should not be blocked by a project_ref condition.
			...(cls.projectRef ? { 'supabase.project_ref': cls.projectRef } : {}),
		},
	};

	const stub = getStub(env);
	// Note: the second arg to authorize() (zoneId) is a no-op for Supabase keys (no zone_id set).
	// Resource scoping is enforced by the policy engine via ctx.resource / ctx.action.
	const auth = await stub.authorize(keyId, cls.projectRef ?? '', [ctx]);
	if (!auth.authorized) {
		const status = authErrorStatus(auth.error);
		log.breadcrumb = 'supabase-mgmt-authz-denied';
		log.status = status;
		log.authError = auth.error;
		console.log(JSON.stringify(log));
		return sbJsonError(status, auth.error ?? 'Forbidden');
	}

	// Resolve the PAT. A key bound to a specific upstream token (the normal case) MUST use that
	// token — never a scope/ref match — so one key can't have another credential swapped in, and
	// account-level calls don't forward whichever wildcard token happens to be newest. Only fall
	// back to scope/ref resolution for legacy unbound keys. Mirrors the CF/S3/purge proxies.
	const pat = auth.upstreamTokenId
		? await stub.resolveUpstreamTokenById(auth.upstreamTokenId)
		: await stub.resolveSupabaseToken(cls.projectRef ?? '*');
	if (!pat) {
		log.breadcrumb = auth.upstreamTokenId ? 'supabase-mgmt-pinned-pat-not-found' : 'supabase-mgmt-pat-not-found';
		log.status = 502;
		console.log(JSON.stringify(log));
		return sbJsonError(
			502,
			auth.upstreamTokenId
				? `Pinned upstream token ${auth.upstreamTokenId} not found`
				: 'No Supabase Personal Access Token registered for this project',
		);
	}

	const body = method !== 'GET' && method !== 'HEAD' ? await c.req.arrayBuffer() : undefined;
	const upstreamStart = Date.now();
	const upstream = await proxyToManagementApi(path, pat, method, body, url.search.slice(1), c.req.header('content-type') ?? null);
	const upstreamLatency = Date.now() - upstreamStart;
	const text = await upstream.text();

	log.breadcrumb = 'supabase-mgmt-ok';
	log.status = upstream.status;
	log.upstreamLatencyMs = upstreamLatency;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));

	if (env.ANALYTICS_DB) {
		const event: SupabaseProxyEvent = {
			key_id: keyId,
			project_ref: cls.projectRef,
			category: cls.category,
			action: cls.action,
			status: upstream.status,
			upstream_status: upstream.status,
			duration_ms: Date.now() - start,
			upstream_latency_ms: upstreamLatency,
			response_size: new TextEncoder().encode(text).byteLength,
			response_detail: extractResponseDetail(text),
			created_by: auth.keyName ? `key:${auth.keyName}` : AUDIT_CREATED_BY_API_KEY,
			created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logSupabaseProxyEvent(env.ANALYTICS_DB, event));
	}

	return buildProxyResponse(upstream, text);
};

// Both the stable (/v1) and experimental (/v0) Management API surfaces use the same PAT-swap
// handler. The classifier decides which individual paths are in scope; unmapped paths 404.
supabaseApp.all('/v1/*', managementApiHandler);
supabaseApp.all('/v0/*', managementApiHandler);
