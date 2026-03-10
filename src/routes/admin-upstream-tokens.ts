import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { resolveCreatedBy, validateCfToken, emitAudit } from './admin-helpers';
import {
	createUpstreamTokenSchema,
	updateUpstreamTokenSchema,
	idParamSchema,
	jsonError,
	parseJsonBody,
	parseParams,
	parseBulkBody,
} from './admin-schemas';
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
		scope_type: parsed.scope_type,
		zone_ids: parsed.zone_ids,
		expires_in_days: parsed.expires_in_days,
		created_by: resolveCreatedBy(identity, parsed.created_by),
	});

	log.status = 200;
	log.tokenId = result.token.id;
	log.scopeType = parsed.scope_type;
	log.zoneIds = parsed.zone_ids;
	if (parsed.expires_in_days) log.expiresInDays = parsed.expires_in_days;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'create_upstream_token',
		entity_type: 'upstream_token',
		entity_id: result.token.id,
		detail: JSON.stringify({
			name: parsed.name,
			scope_type: parsed.scope_type,
			zone_ids: parsed.zone_ids,
			...(parsed.expires_in_days && { expires_in_days: parsed.expires_in_days }),
		}),
	});

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

// ─── Update ─────────────────────────────────────────────────────────────────

adminUpstreamTokensApp.patch('/:id', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.updateUpstreamToken', ts: new Date().toISOString() };

	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const parsed = await parseJsonBody(c, updateUpstreamTokenSchema, log);
	if (parsed instanceof Response) return parsed;

	const stub = getStub(c.env);
	const result = await stub.updateUpstreamToken(params.id, parsed);

	if (!result) {
		log.status = 404;
		console.log(JSON.stringify(log));
		return jsonError(c, 404, 'Upstream token not found');
	}

	log.status = 200;
	log.tokenId = params.id;
	log.updatedFields = Object.keys(parsed);
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'update_upstream_token',
		entity_type: 'upstream_token',
		entity_id: params.id,
		detail: JSON.stringify(parsed),
	});

	return c.json({ success: true, result: result.token });
});

// ─── Delete ─────────────────────────────────────────────────────────────────

adminUpstreamTokensApp.delete('/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const stub = getStub(c.env);

	// Check for bound keys — warn but don't block
	const boundKeyCount = await stub.countKeysByUpstreamToken(params.id);

	const deleted = await stub.deleteUpstreamToken(params.id);

	console.log(
		JSON.stringify({
			route: 'admin.deleteUpstreamToken',
			tokenId: params.id,
			deleted,
			boundKeyCount,
			ts: new Date().toISOString(),
		}),
	);

	if (!deleted) {
		return jsonError(c, 404, 'Upstream token not found');
	}

	emitAudit(c, {
		action: 'delete_upstream_token',
		entity_type: 'upstream_token',
		entity_id: params.id,
		detail: boundKeyCount > 0 ? JSON.stringify({ orphaned_keys: boundKeyCount }) : null,
	});

	const warnings: { type: string; message: string }[] = [];
	if (boundKeyCount > 0) {
		warnings.push({
			type: 'orphaned_keys',
			message: `${boundKeyCount} active API key(s) were bound to this upstream token and will no longer be able to reach upstream`,
		});
	}

	return c.json({ success: true, result: { deleted: true }, ...(warnings.length > 0 && { warnings }) });
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

	emitAudit(c, {
		action: 'bulk_delete_upstream_tokens',
		entity_type: 'upstream_token',
		entity_id: null,
		detail: JSON.stringify({ ids, processed: result.processed }),
	});

	return c.json({ success: true, result });
});
