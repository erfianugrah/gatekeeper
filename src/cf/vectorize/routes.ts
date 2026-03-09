/**
 * Vectorize API proxy routes.
 *
 * Mounted under `/cf/accounts/:accountId/vectorize` by the CF proxy router.
 * Most endpoints use JSON; insert and upsert use application/x-ndjson (binary passthrough).
 */

import { Hono } from 'hono';
import { jsonServiceRoute, binaryServiceRoute } from '../service-handler';
import { cfJsonError } from '../proxy-helpers';
import { vectorizeAccountContext, vectorizeIndexContext } from './operations';
import type { CfProxyEnv } from '../router';

const SVC = 'vectorize';
const V2 = 'v2/indexes';

export const vectorizeRoutes = new Hono<CfProxyEnv>();

// ─── Index CRUD ─────────────────────────────────────────────────────────────

vectorizeRoutes.post(`/${V2}`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:create_index',
			[vectorizeAccountContext(accountId, 'vectorize:create_index', rf)],
			`/accounts/${accountId}/vectorize/${V2}`,
			'POST',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.create_index', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.get(`/${V2}`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:list_indexes',
			[vectorizeAccountContext(accountId, 'vectorize:list_indexes', rf)],
			`/accounts/${accountId}/vectorize/${V2}`,
			'GET',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.list_indexes', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.get(`/${V2}/:indexName`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:get_index',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:get_index', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}`,
			'GET',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.get_index', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.delete(`/${V2}/:indexName`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:delete_index',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:delete_index', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}`,
			'DELETE',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.delete_index', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Index operations ───────────────────────────────────────────────────────

vectorizeRoutes.get(`/${V2}/:indexName/info`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:get_info',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:get_info', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/info`,
			'GET',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.get_info', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.post(`/${V2}/:indexName/query`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:query',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:query', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/query`,
			'POST',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.query', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// Insert and upsert use application/x-ndjson (binary passthrough)
vectorizeRoutes.post(`/${V2}/:indexName/insert`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return binaryServiceRoute(
			c,
			SVC,
			'vectorize:insert',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:insert', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/insert`,
			'POST',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.insert', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.post(`/${V2}/:indexName/upsert`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return binaryServiceRoute(
			c,
			SVC,
			'vectorize:upsert',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:upsert', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/upsert`,
			'POST',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.upsert', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.post(`/${V2}/:indexName/get_by_ids`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:get_by_ids',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:get_by_ids', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/get_by_ids`,
			'POST',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.get_by_ids', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.post(`/${V2}/:indexName/delete_by_ids`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:delete_by_ids',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:delete_by_ids', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/delete_by_ids`,
			'POST',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.delete_by_ids', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.get(`/${V2}/:indexName/list`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:list_vectors',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:list_vectors', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/list`,
			'GET',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.list_vectors', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Metadata index ─────────────────────────────────────────────────────────

vectorizeRoutes.post(`/${V2}/:indexName/metadata_index/create`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:create_metadata_index',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:create_metadata_index', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/metadata_index/create`,
			'POST',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.create_metadata_index', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.get(`/${V2}/:indexName/metadata_index/list`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:list_metadata_indexes',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:list_metadata_indexes', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/metadata_index/list`,
			'GET',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.list_metadata_indexes', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

vectorizeRoutes.post(`/${V2}/:indexName/metadata_index/delete`, async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const indexName = c.req.param('indexName');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'vectorize:delete_metadata_index',
			[vectorizeIndexContext(accountId, indexName, 'vectorize:delete_metadata_index', rf)],
			`/accounts/${accountId}/vectorize/${V2}/${encodeURIComponent(indexName)}/metadata_index/delete`,
			'POST',
			indexName,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'vectorize.delete_metadata_index', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
