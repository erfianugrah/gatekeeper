/**
 * Shared request handler for CF proxy service routes.
 *
 * Eliminates the duplicated auth + proxy + analytics boilerplate that
 * was copy-pasted across d1/routes.ts, kv/routes.ts, workers/routes.ts.
 * New services (queues, vectorize, hyperdrive) use this shared handler.
 */

import { getStub } from '../do-stub';
import { AUDIT_CREATED_BY_API_KEY } from '../constants';
import { proxyToCfApi, buildProxyResponse, extractResponseDetail, cfJsonError, resolveUpstreamTokenOrError } from './proxy-helpers';
import { logCfProxyEvent } from './analytics';
import type { CfProxyEvent } from './analytics';
import type { RequestContext } from '../policy-types';

/**
 * Full auth + proxy + analytics flow for a CF proxy operation.
 * The shared CF proxy middleware has already handled bearer extraction,
 * account validation, and rate limiting.
 */
export async function handleCfServiceRequest(
	c: any,
	service: string,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	body?: BodyInit | null,
	contentType?: string | null,
	resourceId?: string | null,
	isBinaryPassthrough?: boolean,
): Promise<Response> {
	const env = c.env;
	const keyId: string = c.get('keyId');
	const accountId: string = c.get('accountId');
	const start: number = c.get('startTime');
	const log: Record<string, unknown> = c.get('log');
	log.service = service;
	log.action = action;
	if (resourceId) log.resourceId = resourceId;

	const stub = getStub(env);

	// Authorize BEFORE resolving the upstream token so unauthorized callers
	// cannot probe which accounts have upstream tokens registered.
	const authResult = await stub.authorize(keyId, accountId, contexts);
	if (!authResult.authorized) {
		const status = authResult.error === 'Invalid API key' ? 401 : 403;
		log.status = status;
		log.error = 'auth_failed';
		log.authError = authResult.error;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(status, authResult.error ?? 'Forbidden');
	}

	c.set('keyName', authResult.keyName);

	// Resolve upstream token (post-auth) — key-pinned upstream takes priority
	const tokenOrError = await resolveUpstreamTokenOrError(env, accountId, log, start, authResult.upstreamTokenId);
	if (tokenOrError instanceof Response) return tokenOrError;
	const upstreamToken = tokenOrError;

	// Proxy to CF API — measure upstream latency separately
	const queryString = new URL(c.req.url).search.slice(1);
	const upstreamStart = Date.now();
	const upstream = await proxyToCfApi(upstreamPath, upstreamToken, method, body, queryString || undefined, contentType);
	const upstreamLatencyMs = Date.now() - upstreamStart;

	// Binary passthrough for special content types
	const shouldPassthrough = isBinaryPassthrough && upstream.status >= 200 && upstream.status < 300;
	const responseBody = shouldPassthrough ? null : await upstream.text();
	const responseSize = responseBody != null ? new TextEncoder().encode(responseBody).byteLength : null;

	log.status = upstream.status;
	log.upstreamStatus = upstream.status;
	log.upstreamLatencyMs = upstreamLatencyMs;
	if (responseSize != null) log.responseSize = responseSize;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));

	// Drain bucket on upstream 429
	if (upstream.status === 429) {
		c.executionCtx.waitUntil(stub.drainCfProxyBucket());
	}

	// Analytics
	if (env.ANALYTICS_DB) {
		const event: CfProxyEvent = {
			key_id: keyId,
			account_id: accountId,
			service,
			action,
			resource_id: resourceId ?? null,
			status: upstream.status,
			upstream_status: upstream.status,
			duration_ms: Date.now() - start,
			upstream_latency_ms: upstreamLatencyMs,
			response_size: responseSize,
			response_detail: responseBody ? extractResponseDetail(responseBody) : null,
			created_by: authResult.keyName ? `key:${authResult.keyName}` : AUDIT_CREATED_BY_API_KEY,
			created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logCfProxyEvent(env.ANALYTICS_DB, event));
	}

	if (shouldPassthrough) {
		return buildProxyResponse(upstream, null);
	}
	return buildProxyResponse(upstream, responseBody!);
}

/** Shorthand for a JSON request (GET/DELETE with no body, or POST/PUT/PATCH with JSON body). */
export async function jsonServiceRoute(
	c: any,
	service: string,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	resourceId?: string | null,
): Promise<Response> {
	if (method === 'GET' || method === 'DELETE' || method === 'HEAD') {
		return handleCfServiceRequest(c, service, action, contexts, upstreamPath, method, null, null, resourceId);
	}
	const bodyText = await c.req.text();
	return handleCfServiceRequest(c, service, action, contexts, upstreamPath, method, bodyText, 'application/json', resourceId);
}

/** Shorthand for a binary passthrough request (body forwarded as-is). */
export async function binaryServiceRoute(
	c: any,
	service: string,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	resourceId?: string | null,
	isBinaryResponse?: boolean,
): Promise<Response> {
	const rawBody = await c.req.arrayBuffer();
	const contentType = c.req.header('content-type') ?? null;
	return handleCfServiceRequest(c, service, action, contexts, upstreamPath, method, rawBody, contentType, resourceId, isBinaryResponse);
}
