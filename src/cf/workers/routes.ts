/**
 * Workers API proxy routes.
 *
 * Proxies requests to the Cloudflare Workers API with per-script policy enforcement.
 * Mounted under `/cf/accounts/:accountId/workers` by the CF proxy router.
 *
 * All wrangler CLI interactions flow through these routes when
 * CLOUDFLARE_API_BASE_URL is pointed at Gatekeeper.
 *
 * Route groups:
 *   /scripts                         — list scripts
 *   /scripts/:scriptName             — CRUD, content, settings, versions, deployments, secrets, etc.
 *   /subdomain                       — account workers.dev subdomain
 *   /account-settings                — account settings
 *   /domains                         — custom domains
 *   /observability/telemetry/*       — observability queries
 */

import { Hono } from 'hono';
import { getStub } from '../../do-stub';
import { AUDIT_CREATED_BY_API_KEY } from '../../constants';
import {
	proxyToCfApi,
	buildProxyResponse,
	extractResponseDetail,
	cfJsonError,
	resolveUpstreamTokenOrError,
	consumeCfProxyRateLimitOrError,
} from '../proxy-helpers';
import { logCfProxyEvent } from '../analytics';
import {
	workersListScriptsContext,
	workersAccountSubdomainContext,
	workersAccountSettingsContext,
	workersDomainContext,
	workersTelemetryContext,
	workersScriptContext,
} from './operations';
import type { CfProxyEnv } from '../router';
import type { CfProxyEvent } from '../analytics';
import type { RequestContext } from '../../policy-types';

// ─── Route ──────────────────────────────────────────────────────────────────

export const workersRoutes = new Hono<CfProxyEnv>();

// ─── Shared handler ─────────────────────────────────────────────────────────

/**
 * Full auth + proxy + analytics flow for a Workers operation.
 * The shared CF proxy middleware already handled bearer extraction,
 * account validation, upstream token resolution, and rate limiting.
 *
 * When isBinaryPassthrough is true, the upstream response body is streamed
 * directly without text conversion (for script download / content endpoints).
 */
async function handleWorkersRequest(
	c: any,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	body?: BodyInit | null,
	contentType?: string | null,
	resourceId?: string | null,
	isBinaryPassthrough?: boolean,
	extraHeaders?: Record<string, string>,
): Promise<Response> {
	const env = c.env;
	const keyId: string = c.get('keyId');
	const accountId: string = c.get('accountId');
	const start: number = c.get('startTime');
	const log: Record<string, unknown> = c.get('log');
	log.service = 'workers';
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

	// Rate limit — account-level CF proxy bucket (post-auth)
	const rateLimitError = await consumeCfProxyRateLimitOrError(env, log, start);
	if (rateLimitError) return rateLimitError;

	// Resolve upstream token (post-auth) — pass key-pinned upstream token ID if present
	const tokenOrError = await resolveUpstreamTokenOrError(env, accountId, log, start, authResult.upstreamTokenId);
	if (tokenOrError instanceof Response) return tokenOrError;
	const upstreamToken = tokenOrError;

	// Proxy to CF API — measure upstream latency separately
	const queryString = new URL(c.req.url).search.slice(1);
	const upstreamStart = Date.now();
	const upstream = await proxyToCfApi(upstreamPath, upstreamToken, method, body, queryString || undefined, contentType, extraHeaders);
	const upstreamLatencyMs = Date.now() - upstreamStart;

	// Binary passthrough for script download / content endpoints
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
			service: 'workers',
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

// ─── Helper: JSON route ─────────────────────────────────────────────────────

/** Shorthand for a simple JSON request (GET/DELETE with no body, or POST/PUT/PATCH with JSON body). */
async function jsonRoute(
	c: any,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	resourceId?: string | null,
): Promise<Response> {
	if (method === 'GET' || method === 'DELETE' || method === 'HEAD') {
		return handleWorkersRequest(c, action, contexts, upstreamPath, method, null, null, resourceId);
	}
	const bodyText = await c.req.text();
	return handleWorkersRequest(c, action, contexts, upstreamPath, method, bodyText, 'application/json', resourceId);
}

/** Shorthand for a binary/multipart passthrough request (body forwarded as-is). */
async function binaryRoute(
	c: any,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	resourceId?: string | null,
	isBinaryResponse?: boolean,
): Promise<Response> {
	const rawBody = await c.req.arrayBuffer();
	const contentType = c.req.header('content-type') ?? null;
	// Forward custom CF headers that wrangler sends for content uploads
	const extraHeaders: Record<string, string> = {};
	const cfBodyPart = c.req.header('cf-worker-body-part');
	if (cfBodyPart) extraHeaders['CF-WORKER-BODY-PART'] = cfBodyPart;
	const cfMainModule = c.req.header('cf-worker-main-module-part');
	if (cfMainModule) extraHeaders['CF-WORKER-MAIN-MODULE-PART'] = cfMainModule;
	return handleWorkersRequest(c, action, contexts, upstreamPath, method, rawBody, contentType, resourceId, isBinaryResponse, extraHeaders);
}

// ═══════════════════════════════════════════════════════════════════════════
// Scripts CRUD
// ═══════════════════════════════════════════════════════════════════════════

// ─── List scripts ───────────────────────────────────────────────────────────

workersRoutes.get('/scripts', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersListScriptsContext(accountId, requestFields)];
		return jsonRoute(c, 'workers:list_scripts', contexts, `/accounts/${accountId}/workers/scripts`, 'GET');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.list_scripts', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Scripts search ─────────────────────────────────────────────────────────

workersRoutes.get('/scripts-search', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersListScriptsContext(accountId, requestFields)];
		return jsonRoute(c, 'workers:list_scripts', contexts, `/accounts/${accountId}/workers/scripts-search`, 'GET');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.scripts_search', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Upload/update script (multipart — used by `wrangler deploy` legacy path) ─

workersRoutes.put('/scripts/:scriptName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:update_script', requestFields)];
		return binaryRoute(
			c,
			'workers:update_script',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
			'PUT',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_script', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Get script (returns raw JS — application/javascript) ───────────────────

workersRoutes.get('/scripts/:scriptName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:get_script', requestFields)];
		return handleWorkersRequest(
			c,
			'workers:get_script',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
			'GET',
			null,
			null,
			scriptName,
			true, // binary passthrough — upstream returns application/javascript
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_script', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Delete script ──────────────────────────────────────────────────────────

workersRoutes.delete('/scripts/:scriptName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:delete_script', requestFields)];
		return jsonRoute(
			c,
			'workers:delete_script',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
			'DELETE',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.delete_script', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Script content (versioned upload/download)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Upload content (multipart — primary `wrangler deploy` path) ────────────

workersRoutes.put('/scripts/:scriptName/content', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:update_content', requestFields)];
		return binaryRoute(
			c,
			'workers:update_content',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/content`,
			'PUT',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_content', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Get content v2 (binary response) ───────────────────────────────────────

workersRoutes.get('/scripts/:scriptName/content/v2', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:get_content', requestFields)];
		return handleWorkersRequest(
			c,
			'workers:get_content',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/content/v2`,
			'GET',
			null,
			null,
			scriptName,
			true, // binary passthrough
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_content', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

// ─── Script+Version settings (PATCH is multipart, GET is JSON) ──────────────

workersRoutes.patch('/scripts/:scriptName/settings', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:update_settings', requestFields)];
		return binaryRoute(
			c,
			'workers:update_settings',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
			'PATCH',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_settings', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/settings', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:get_settings', requestFields)];
		return jsonRoute(
			c,
			'workers:get_settings',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_settings', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Script-level settings (JSON only) ──────────────────────────────────────

workersRoutes.patch('/scripts/:scriptName/script-settings', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:update_script_settings', requestFields)];
		return jsonRoute(
			c,
			'workers:update_script_settings',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/script-settings`,
			'PATCH',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_script_settings', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/script-settings', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:get_script_settings', requestFields)];
		return jsonRoute(
			c,
			'workers:get_script_settings',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/script-settings`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_script_settings', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Versions
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.post('/scripts/:scriptName/versions', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:create_version', requestFields)];
		return binaryRoute(
			c,
			'workers:create_version',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`,
			'POST',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.create_version', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/versions', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:list_versions', requestFields)];
		return jsonRoute(
			c,
			'workers:list_versions',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.list_versions', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/versions/:versionId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');
	const versionId = c.req.param('versionId');

	try {
		const contexts = [
			workersScriptContext(accountId, scriptName, 'workers:get_version', requestFields, { 'workers.version_id': versionId }),
		];
		return jsonRoute(
			c,
			'workers:get_version',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions/${versionId}`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_version', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Deployments
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.post('/scripts/:scriptName/deployments', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:create_deployment', requestFields)];
		return jsonRoute(
			c,
			'workers:create_deployment',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
			'POST',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.create_deployment', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/deployments', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:list_deployments', requestFields)];
		return jsonRoute(
			c,
			'workers:list_deployments',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.list_deployments', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/deployments/:deploymentId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');
	const deploymentId = c.req.param('deploymentId');

	try {
		const contexts = [
			workersScriptContext(accountId, scriptName, 'workers:get_deployment', requestFields, { 'workers.deployment_id': deploymentId }),
		];
		return jsonRoute(
			c,
			'workers:get_deployment',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments/${deploymentId}`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_deployment', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.delete('/scripts/:scriptName/deployments/:deploymentId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');
	const deploymentId = c.req.param('deploymentId');

	try {
		const contexts = [
			workersScriptContext(accountId, scriptName, 'workers:delete_deployment', requestFields, { 'workers.deployment_id': deploymentId }),
		];
		return jsonRoute(
			c,
			'workers:delete_deployment',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments/${deploymentId}`,
			'DELETE',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.delete_deployment', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Secrets
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.put('/scripts/:scriptName/secrets', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:update_secret', requestFields)];
		return jsonRoute(
			c,
			'workers:update_secret',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
			'PUT',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_secret', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/secrets', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:list_secrets', requestFields)];
		return jsonRoute(
			c,
			'workers:list_secrets',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.list_secrets', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/secrets/:secretName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');
	const secretName = c.req.param('secretName');

	try {
		const contexts = [
			workersScriptContext(accountId, scriptName, 'workers:get_secret', requestFields, { 'workers.secret_name': secretName }),
		];
		return jsonRoute(
			c,
			'workers:get_secret',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets/${encodeURIComponent(secretName)}`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_secret', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.delete('/scripts/:scriptName/secrets/:secretName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');
	const secretName = c.req.param('secretName');

	try {
		const contexts = [
			workersScriptContext(accountId, scriptName, 'workers:delete_secret', requestFields, { 'workers.secret_name': secretName }),
		];
		return jsonRoute(
			c,
			'workers:delete_secret',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets/${encodeURIComponent(secretName)}`,
			'DELETE',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.delete_secret', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Schedules (cron triggers)
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.put('/scripts/:scriptName/schedules', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:update_schedules', requestFields)];
		return jsonRoute(
			c,
			'workers:update_schedules',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
			'PUT',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_schedules', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/schedules', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:get_schedules', requestFields)];
		return jsonRoute(
			c,
			'workers:get_schedules',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_schedules', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Tails (live log tailing)
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.post('/scripts/:scriptName/tails', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:create_tail', requestFields)];
		return jsonRoute(
			c,
			'workers:create_tail',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/tails`,
			'POST',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.create_tail', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/tails', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:list_tails', requestFields)];
		return jsonRoute(
			c,
			'workers:list_tails',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/tails`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.list_tails', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.delete('/scripts/:scriptName/tails/:tailId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');
	const tailId = c.req.param('tailId');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:delete_tail', requestFields)];
		return jsonRoute(
			c,
			'workers:delete_tail',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/tails/${tailId}`,
			'DELETE',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.delete_tail', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Script subdomain (workers.dev toggle per script)
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.post('/scripts/:scriptName/subdomain', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:update_subdomain', requestFields)];
		return jsonRoute(
			c,
			'workers:update_subdomain',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
			'POST',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_subdomain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/scripts/:scriptName/subdomain', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:get_subdomain', requestFields)];
		return jsonRoute(
			c,
			'workers:get_subdomain',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
			'GET',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_subdomain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.delete('/scripts/:scriptName/subdomain', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:delete_subdomain', requestFields)];
		return jsonRoute(
			c,
			'workers:delete_subdomain',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
			'DELETE',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.delete_subdomain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Assets upload session
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.post('/scripts/:scriptName/assets-upload-session', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const scriptName = c.req.param('scriptName');

	try {
		const contexts = [workersScriptContext(accountId, scriptName, 'workers:upload_assets', requestFields)];
		return jsonRoute(
			c,
			'workers:upload_assets',
			contexts,
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`,
			'POST',
			scriptName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.upload_assets', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Account subdomain (workers.dev)
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.get('/subdomain', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersAccountSubdomainContext(accountId, 'workers:get_account_subdomain', requestFields)];
		return jsonRoute(c, 'workers:get_account_subdomain', contexts, `/accounts/${accountId}/workers/subdomain`, 'GET');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_account_subdomain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.put('/subdomain', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersAccountSubdomainContext(accountId, 'workers:update_account_subdomain', requestFields)];
		return jsonRoute(c, 'workers:update_account_subdomain', contexts, `/accounts/${accountId}/workers/subdomain`, 'PUT');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_account_subdomain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.delete('/subdomain', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersAccountSubdomainContext(accountId, 'workers:delete_account_subdomain', requestFields)];
		return jsonRoute(c, 'workers:delete_account_subdomain', contexts, `/accounts/${accountId}/workers/subdomain`, 'DELETE');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.delete_account_subdomain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Account settings
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.get('/account-settings', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersAccountSettingsContext(accountId, 'workers:get_account_settings', requestFields)];
		return jsonRoute(c, 'workers:get_account_settings', contexts, `/accounts/${accountId}/workers/account-settings`, 'GET');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_account_settings', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.put('/account-settings', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersAccountSettingsContext(accountId, 'workers:update_account_settings', requestFields)];
		return jsonRoute(c, 'workers:update_account_settings', contexts, `/accounts/${accountId}/workers/account-settings`, 'PUT');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_account_settings', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Custom domains
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.get('/domains', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersDomainContext(accountId, 'workers:list_domains', undefined, requestFields)];
		return jsonRoute(c, 'workers:list_domains', contexts, `/accounts/${accountId}/workers/domains`, 'GET');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.list_domains', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.put('/domains', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersDomainContext(accountId, 'workers:update_domain', undefined, requestFields)];
		return jsonRoute(c, 'workers:update_domain', contexts, `/accounts/${accountId}/workers/domains`, 'PUT');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.update_domain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.get('/domains/:domainId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const domainId = c.req.param('domainId');

	try {
		const contexts = [workersDomainContext(accountId, 'workers:get_domain', domainId, requestFields)];
		return jsonRoute(c, 'workers:get_domain', contexts, `/accounts/${accountId}/workers/domains/${domainId}`, 'GET', domainId);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.get_domain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.delete('/domains/:domainId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const domainId = c.req.param('domainId');

	try {
		const contexts = [workersDomainContext(accountId, 'workers:delete_domain', domainId, requestFields)];
		return jsonRoute(c, 'workers:delete_domain', contexts, `/accounts/${accountId}/workers/domains/${domainId}`, 'DELETE', domainId);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.delete_domain', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Observability / Telemetry
// ═══════════════════════════════════════════════════════════════════════════

workersRoutes.post('/observability/telemetry/keys', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersTelemetryContext(accountId, requestFields)];
		return jsonRoute(c, 'workers:telemetry', contexts, `/accounts/${accountId}/workers/observability/telemetry/keys`, 'POST');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.telemetry_keys', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.post('/observability/telemetry/query', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersTelemetryContext(accountId, requestFields)];
		return jsonRoute(c, 'workers:telemetry', contexts, `/accounts/${accountId}/workers/observability/telemetry/query`, 'POST');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.telemetry_query', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

workersRoutes.post('/observability/telemetry/values', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [workersTelemetryContext(accountId, requestFields)];
		return jsonRoute(c, 'workers:telemetry', contexts, `/accounts/${accountId}/workers/observability/telemetry/values`, 'POST');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'workers.telemetry_values', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
