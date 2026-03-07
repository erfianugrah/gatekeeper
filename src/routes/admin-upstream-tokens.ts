import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { resolveCreatedBy, validateCfToken } from './admin-helpers';
import { createUpstreamTokenSchema, idParamSchema, jsonError, parseJsonBody, parseParams, parseBulkBody } from './admin-schemas';
import type { ValidationWarning } from './admin-helpers';
import type { HonoEnv } from '../types';

// ─── Admin: Upstream CF API Token Management ────────────────────────────────

export const adminUpstreamTokensApp = new Hono<HonoEnv>();

// ─── Create ─────────────────────────────────────────────────────────────────

adminUpstreamTokensApp.post('/', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.createUpstreamToken',
		ts: new Date().toISOString(),
	};

	const parsed = await parseJsonBody(c, createUpstreamTokenSchema, log);
	if (parsed instanceof Response) return parsed;

	// Optional validation: probe the CF API to check if the token works
	const warnings: ValidationWarning[] = [];
	if (parsed.validate === true) {
		const warning = await validateCfToken(parsed.token);
		if (warning) {
			warnings.push(warning);
			log.validationFailed = true;
		} else {
			log.validated = true;
		}
	}

	const identity = c.get('accessIdentity');
	const stub = getStub(c.env);
	const result = await stub.createUpstreamToken({
		name: parsed.name,
		token: parsed.token,
		zone_ids: parsed.zone_ids,
		created_by: resolveCreatedBy(identity, parsed.created_by),
	});

	log.status = 200;
	log.tokenId = result.token.id;
	log.zoneIds = parsed.zone_ids;
	console.log(JSON.stringify(log));

	return c.json({ success: true, result: result.token, ...(warnings.length > 0 && { warnings }) });
});

// ─── List ───────────────────────────────────────────────────────────────────

adminUpstreamTokensApp.get('/', async (c) => {
	const stub = getStub(c.env);
	const tokens = await stub.listUpstreamTokens();

	console.log(
		JSON.stringify({
			route: 'admin.listUpstreamTokens',
			count: tokens.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: tokens });
});

// ─── Get ────────────────────────────────────────────────────────────────────

adminUpstreamTokensApp.get('/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const stub = getStub(c.env);
	const result = await stub.getUpstreamToken(params.id);

	if (!result) {
		console.log(JSON.stringify({ breadcrumb: 'admin-get-upstream-token-not-found', id: params.id }));
		return jsonError(c, 404, 'Upstream token not found');
	}

	return c.json({ success: true, result: result.token });
});

// ─── Delete ─────────────────────────────────────────────────────────────────

adminUpstreamTokensApp.delete('/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const stub = getStub(c.env);
	const deleted = await stub.deleteUpstreamToken(params.id);

	console.log(
		JSON.stringify({
			route: 'admin.deleteUpstreamToken',
			tokenId: params.id,
			deleted,
			ts: new Date().toISOString(),
		}),
	);

	if (!deleted) {
		return jsonError(c, 404, 'Upstream token not found');
	}

	return c.json({ success: true, result: { deleted: true } });
});

// ─── Bulk delete ────────────────────────────────────────────────────────────

adminUpstreamTokensApp.post('/bulk-delete', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkDeleteUpstreamTokens', ts: new Date().toISOString() };

	const body = await parseBulkBody(c, 'ids', log);
	if (body instanceof Response) return body;

	const { ids, dryRun } = body;
	const stub = getStub(c.env);

	if (dryRun) {
		const preview = await stub.bulkInspectUpstreamTokens(ids, 'deleted');
		log.status = 200;
		log.dryRun = true;
		log.count = ids.length;
		console.log(JSON.stringify(log));
		return c.json({ success: true, result: preview });
	}

	const result = await stub.bulkDeleteUpstreamTokens(ids);
	log.status = 200;
	log.processed = result.processed;
	console.log(JSON.stringify(log));
	return c.json({ success: true, result });
});
