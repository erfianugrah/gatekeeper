/**
 * KV API proxy routes.
 *
 * Proxies requests to the Cloudflare KV API with per-namespace policy enforcement.
 * Mounted under `/cf/accounts/:accountId/storage/kv` by the CF proxy router.
 *
 * Route structure mirrors the CF API (relative to the mount point):
 *   POST   /namespaces                                       -> kv:create_namespace
 *   GET    /namespaces                                       -> kv:list_namespaces
 *   GET    /namespaces/:namespaceId                          -> kv:get_namespace
 *   PUT    /namespaces/:namespaceId                          -> kv:update_namespace
 *   DELETE /namespaces/:namespaceId                          -> kv:delete_namespace
 *   GET    /namespaces/:namespaceId/keys                     -> kv:list_keys
 *   PUT    /namespaces/:namespaceId/values/:keyName          -> kv:put_value   (multipart/form-data)
 *   GET    /namespaces/:namespaceId/values/:keyName          -> kv:get_value   (returns binary)
 *   DELETE /namespaces/:namespaceId/values/:keyName          -> kv:delete_value
 *   GET    /namespaces/:namespaceId/metadata/:keyName        -> kv:get_metadata
 *   PUT    /namespaces/:namespaceId/bulk                     -> kv:bulk_write
 *   POST   /namespaces/:namespaceId/bulk/delete              -> kv:bulk_delete
 *   POST   /namespaces/:namespaceId/bulk/get                 -> kv:bulk_get
 */

import { Hono } from 'hono';
import { getStub } from '../../do-stub';
import { AUDIT_CREATED_BY_API_KEY } from '../../constants';
import { proxyToCfApi, buildProxyResponse, extractResponseDetail, cfJsonError } from '../proxy-helpers';
import { logCfProxyEvent } from '../analytics';
import {
	kvListNamespacesContext,
	kvCreateNamespaceContext,
	kvGetNamespaceContext,
	kvUpdateNamespaceContext,
	kvDeleteNamespaceContext,
	kvListKeysContext,
	kvPutValueContext,
	kvGetValueContext,
	kvDeleteValueContext,
	kvGetMetadataContext,
	kvBulkWriteContext,
	kvBulkDeleteContext,
	kvBulkGetContext,
} from './operations';
import type { CfProxyEnv } from '../router';
import type { CfProxyEvent } from '../analytics';
import type { RequestContext } from '../../policy-types';

// ─── Route ──────────────────────────────────────────────────────────────────

export const kvRoutes = new Hono<CfProxyEnv>();

// ─── Shared handler ─────────────────────────────────────────────────────────

/**
 * Full auth + proxy + analytics flow for a KV operation.
 * The shared CF proxy middleware already handled bearer extraction,
 * account validation, upstream token resolution, and rate limiting.
 */
async function handleKvRequest(
	c: any,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	body?: BodyInit | null,
	contentType?: string | null,
	resourceId?: string | null,
): Promise<Response> {
	const env = c.env;
	const keyId: string = c.get('keyId');
	const accountId: string = c.get('accountId');
	const upstreamToken: string = c.get('upstreamToken');
	const start: number = c.get('startTime');
	const log: Record<string, unknown> = c.get('log');
	log.service = 'kv';
	log.action = action;
	if (resourceId) log.resourceId = resourceId;

	const stub = getStub(env);

	// Authorize
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

	// Proxy to CF API
	const queryString = method === 'GET' || method === 'PUT' ? new URL(c.req.url).search.slice(1) : '';
	const upstream = await proxyToCfApi(upstreamPath, upstreamToken, method, body, queryString || undefined, contentType);

	// For value reads (binary), pass the raw body through without text conversion
	const isBinaryResponse = action === 'kv:get_value' && upstream.status >= 200 && upstream.status < 300;
	const responseBody = isBinaryResponse ? null : await upstream.text();

	log.status = upstream.status;
	log.upstreamStatus = upstream.status;
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
			service: 'kv',
			action,
			resource_id: resourceId ?? null,
			status: upstream.status,
			upstream_status: upstream.status,
			duration_ms: Date.now() - start,
			response_detail: responseBody ? extractResponseDetail(responseBody) : null,
			created_by: authResult.keyName ? `key:${authResult.keyName}` : AUDIT_CREATED_BY_API_KEY,
			created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logCfProxyEvent(env.ANALYTICS_DB, event));
	}

	// Binary passthrough for value reads
	if (isBinaryResponse) {
		return buildProxyResponse(upstream, null);
	}

	return buildProxyResponse(upstream, responseBody!);
}

// ─── Create namespace ───────────────────────────────────────────────────────

kvRoutes.post('/namespaces', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const bodyText = await c.req.text();
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(bodyText);
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		const contexts = [kvCreateNamespaceContext(accountId, body, requestFields)];
		return handleKvRequest(
			c,
			'kv:create_namespace',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces`,
			'POST',
			bodyText,
			'application/json',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.create_namespace', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── List namespaces ────────────────────────────────────────────────────────

kvRoutes.get('/namespaces', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [kvListNamespacesContext(accountId, requestFields)];
		return handleKvRequest(c, 'kv:list_namespaces', contexts, `/accounts/${accountId}/storage/kv/namespaces`, 'GET');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.list_namespaces', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── List keys (before /:namespaceId to avoid capture) ──────────────────────

kvRoutes.get('/namespaces/:namespaceId/keys', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');

	try {
		const contexts = [kvListKeysContext(accountId, namespaceId, requestFields)];
		return handleKvRequest(
			c,
			'kv:list_keys',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys`,
			'GET',
			null,
			null,
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.list_keys', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Put value (multipart/form-data passthrough) ────────────────────────────

kvRoutes.put('/namespaces/:namespaceId/values/:keyName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');
	const keyName = c.req.param('keyName');

	try {
		const contexts = [kvPutValueContext(accountId, namespaceId, keyName, requestFields)];
		// Pass request body and content-type through as-is (multipart/form-data)
		const rawBody = await c.req.arrayBuffer();
		const contentType = c.req.header('content-type') ?? null;
		return handleKvRequest(
			c,
			'kv:put_value',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(keyName)}`,
			'PUT',
			rawBody,
			contentType,
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.put_value', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Get value (binary passthrough) ─────────────────────────────────────────

kvRoutes.get('/namespaces/:namespaceId/values/:keyName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');
	const keyName = c.req.param('keyName');

	try {
		const contexts = [kvGetValueContext(accountId, namespaceId, keyName, requestFields)];
		return handleKvRequest(
			c,
			'kv:get_value',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(keyName)}`,
			'GET',
			null,
			null,
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.get_value', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Delete value ───────────────────────────────────────────────────────────

kvRoutes.delete('/namespaces/:namespaceId/values/:keyName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');
	const keyName = c.req.param('keyName');

	try {
		const contexts = [kvDeleteValueContext(accountId, namespaceId, keyName, requestFields)];
		return handleKvRequest(
			c,
			'kv:delete_value',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(keyName)}`,
			'DELETE',
			null,
			null,
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.delete_value', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Get metadata ───────────────────────────────────────────────────────────

kvRoutes.get('/namespaces/:namespaceId/metadata/:keyName', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');
	const keyName = c.req.param('keyName');

	try {
		const contexts = [kvGetMetadataContext(accountId, namespaceId, keyName, requestFields)];
		return handleKvRequest(
			c,
			'kv:get_metadata',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/metadata/${encodeURIComponent(keyName)}`,
			'GET',
			null,
			null,
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.get_metadata', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Bulk write ─────────────────────────────────────────────────────────────

kvRoutes.put('/namespaces/:namespaceId/bulk', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');

	try {
		const bodyText = await c.req.text();
		const contexts = [kvBulkWriteContext(accountId, namespaceId, requestFields)];
		return handleKvRequest(
			c,
			'kv:bulk_write',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
			'PUT',
			bodyText,
			'application/json',
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.bulk_write', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Bulk delete ────────────────────────────────────────────────────────────

kvRoutes.post('/namespaces/:namespaceId/bulk/delete', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');

	try {
		const bodyText = await c.req.text();
		const contexts = [kvBulkDeleteContext(accountId, namespaceId, requestFields)];
		return handleKvRequest(
			c,
			'kv:bulk_delete',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk/delete`,
			'POST',
			bodyText,
			'application/json',
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.bulk_delete', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Bulk get ───────────────────────────────────────────────────────────────

kvRoutes.post('/namespaces/:namespaceId/bulk/get', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');

	try {
		const bodyText = await c.req.text();
		const contexts = [kvBulkGetContext(accountId, namespaceId, requestFields)];
		return handleKvRequest(
			c,
			'kv:bulk_get',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk/get`,
			'POST',
			bodyText,
			'application/json',
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.bulk_get', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Get namespace ──────────────────────────────────────────────────────────

kvRoutes.get('/namespaces/:namespaceId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');

	try {
		const contexts = [kvGetNamespaceContext(accountId, namespaceId, requestFields)];
		return handleKvRequest(
			c,
			'kv:get_namespace',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
			'GET',
			null,
			null,
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.get_namespace', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Update namespace ───────────────────────────────────────────────────────

kvRoutes.put('/namespaces/:namespaceId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');

	try {
		const bodyText = await c.req.text();
		const contexts = [kvUpdateNamespaceContext(accountId, namespaceId, requestFields)];
		return handleKvRequest(
			c,
			'kv:update_namespace',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
			'PUT',
			bodyText,
			'application/json',
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.update_namespace', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Delete namespace ───────────────────────────────────────────────────────

kvRoutes.delete('/namespaces/:namespaceId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const namespaceId = c.req.param('namespaceId');

	try {
		const contexts = [kvDeleteNamespaceContext(accountId, namespaceId, requestFields)];
		return handleKvRequest(
			c,
			'kv:delete_namespace',
			contexts,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
			'DELETE',
			null,
			null,
			namespaceId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'kv.delete_namespace', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
