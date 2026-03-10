import { Hono } from 'hono';
import { validatePolicy } from '../policy-engine';
import { getStub } from '../do-stub';
import { resolveCreatedBy, emitAudit } from './admin-helpers';
import { validateTokenBinding } from './token-binding';
import {
	createKeySchema,
	rotateKeySchema,
	updateKeySchema,
	listKeysQuerySchema,
	deleteQuerySchema,
	idParamSchema,
	jsonError,
	parseJsonBody,
	parseQueryParams,
	parseParams,
	parseBulkBody,
} from './admin-schemas';
import type { CreateKeyRequest, HonoEnv } from '../types';
import type { GatewayConfig } from '../config-registry';
import type { PolicyDocument } from '../policy-types';

// ─── Admin: API Key Management ──────────────────────────────────────────────

export const adminKeysApp = new Hono<HonoEnv>();

// ─── Create key ─────────────────────────────────────────────────────────────

adminKeysApp.post('/', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.createKey',
		ts: new Date().toISOString(),
	};

	const parsed = await parseJsonBody(c, createKeySchema, log);
	if (parsed instanceof Response) return parsed;

	// Deep policy validation (recursion depth, regex safety, etc.) beyond Zod's structural check
	const policyErrors = validatePolicy(parsed.policy);
	if (policyErrors.length > 0) {
		log.status = 400;
		log.error = 'invalid_policy';
		log.policyErrors = policyErrors;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: policyErrors.map((e) => ({
					code: 400,
					message: `${e.path}: ${e.message}`,
				})),
			},
			400,
		);
	}

	const stub = getStub(c.env);

	// Validate upstream token binding — actions and resources must match token scope
	const bindingResult = await validateTokenBinding(stub, parsed.upstream_token_id, parsed.policy as PolicyDocument);
	if (!bindingResult.valid) {
		log.status = 400;
		log.error = 'token_binding_invalid';
		log.bindingErrors = bindingResult.errors;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: bindingResult.errors.map((e) => ({ code: 400, message: e })),
			},
			400,
		);
	}

	const rateLimit = parsed.rate_limit ? validateRateLimitFields(parsed.rate_limit) : undefined;
	if (rateLimit) {
		const gwConfig = await stub.getConfig();
		const rateLimitError = validateRateLimits(rateLimit, gwConfig);
		if (rateLimitError) {
			log.status = 400;
			log.error = 'rate_limit_exceeds_account';
			console.log(JSON.stringify(log));
			return jsonError(c, 400, rateLimitError);
		}
	}

	const identity = c.get('accessIdentity');
	const req: CreateKeyRequest = {
		name: parsed.name,
		zone_id: parsed.zone_id,
		policy: parsed.policy as PolicyDocument,
		created_by: resolveCreatedBy(identity, parsed.created_by),
		expires_in_days: parsed.expires_in_days,
		rate_limit: rateLimit,
		upstream_token_id: parsed.upstream_token_id,
	};

	log.zoneId = req.zone_id ?? 'none';
	log.keyName = req.name;
	log.statementCount = req.policy.statements.length;
	const result = await stub.createKey(req);

	log.status = 200;
	log.keyId = result.key.id.slice(0, 12) + '...';
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'create_key',
		entity_type: 'key',
		entity_id: result.key.id,
		detail: JSON.stringify({ name: req.name, zone_id: req.zone_id, upstream_token_id: req.upstream_token_id }),
	});

	return c.json({ success: true, result });
});

// ─── List keys ──────────────────────────────────────────────────────────────

adminKeysApp.get('/', async (c) => {
	const query = parseQueryParams(c, listKeysQuerySchema);
	if (query instanceof Response) return query;

	const stub = getStub(c.env);
	const keys = await stub.listKeys(query.zone_id, query.status);

	console.log(
		JSON.stringify({
			route: 'admin.listKeys',
			zoneId: query.zone_id ?? 'all',
			filter: query.status ?? 'all',
			count: keys.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: keys });
});

// ─── Get key ────────────────────────────────────────────────────────────────

adminKeysApp.get('/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const zoneId = c.req.query('zone_id') || undefined;
	const stub = getStub(c.env);
	const result = await stub.getKey(params.id);

	if (!result || (zoneId && result.key.zone_id !== zoneId)) {
		console.log(JSON.stringify({ breadcrumb: 'admin-get-key-not-found', keyId: params.id }));
		return jsonError(c, 404, 'Key not found');
	}

	return c.json({ success: true, result });
});

// ─── Rotate key ─────────────────────────────────────────────────────────────

adminKeysApp.post('/:id/rotate', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.rotateKey',
		ts: new Date().toISOString(),
	};

	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const parsed = await parseJsonBody(c, rotateKeySchema, log);
	if (parsed instanceof Response) return parsed;

	const stub = getStub(c.env);
	const result = await stub.rotateKey(params.id, {
		name: parsed.name,
		expires_in_days: parsed.expires_in_days,
	});

	if (!result) {
		log.status = 404;
		log.error = 'key_not_found_or_inactive';
		console.log(JSON.stringify(log));
		return jsonError(c, 404, 'Key not found, already revoked, or expired');
	}

	log.status = 200;
	log.oldKeyId = result.oldKey.id.slice(0, 12) + '...';
	log.newKeyId = result.newKey.id.slice(0, 12) + '...';
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'rotate_key',
		entity_type: 'key',
		entity_id: result.newKey.id,
		detail: JSON.stringify({ old_key_id: result.oldKey.id, new_key_id: result.newKey.id }),
	});

	return c.json({
		success: true,
		result: {
			old_key: result.oldKey,
			new_key: result.newKey,
		},
	});
});

// ─── Update key ─────────────────────────────────────────────────────────────

adminKeysApp.patch('/:id', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.updateKey',
		ts: new Date().toISOString(),
	};

	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const parsed = await parseJsonBody(c, updateKeySchema, log);
	if (parsed instanceof Response) return parsed;

	// Build the update payload
	const updates: Record<string, unknown> = {};
	if (parsed.name !== undefined) updates.name = parsed.name;
	if (parsed.expires_at !== undefined) updates.expires_at = parsed.expires_at;
	if (parsed.rate_limit) {
		if (parsed.rate_limit.bulk_rate !== undefined) updates.bulk_rate = parsed.rate_limit.bulk_rate;
		if (parsed.rate_limit.bulk_bucket !== undefined) updates.bulk_bucket = parsed.rate_limit.bulk_bucket;
		if (parsed.rate_limit.single_rate !== undefined) updates.single_rate = parsed.rate_limit.single_rate;
		if (parsed.rate_limit.single_bucket !== undefined) updates.single_bucket = parsed.rate_limit.single_bucket;
	}

	const stub = getStub(c.env);
	const result = await stub.updateKey(params.id, updates as Parameters<typeof stub.updateKey>[1]);

	if (!result) {
		log.status = 404;
		log.error = 'key_not_found_or_revoked';
		console.log(JSON.stringify(log));
		return jsonError(c, 404, 'Key not found or already revoked');
	}

	log.status = 200;
	log.keyId = params.id.slice(0, 12) + '...';
	log.updatedFields = Object.keys(updates);
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'update_key',
		entity_type: 'key',
		entity_id: params.id,
		detail: JSON.stringify(updates),
	});

	return c.json({ success: true, result });
});

// ─── Revoke / delete key ────────────────────────────────────────────────────

adminKeysApp.delete('/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const query = parseQueryParams(c, deleteQuerySchema);
	if (query instanceof Response) return query;

	const keyId = params.id;
	const stub = getStub(c.env);

	const existing = await stub.getKey(keyId);
	if (!existing || (query.zone_id && existing.key.zone_id !== query.zone_id)) {
		return jsonError(c, 404, 'Key not found');
	}

	if (query.permanent) {
		const deleted = await stub.deleteKey(keyId);

		console.log(
			JSON.stringify({
				route: 'admin.deleteKey',
				zoneId: existing.key.zone_id,
				keyId: keyId.slice(0, 12) + '...',
				deleted,
				ts: new Date().toISOString(),
			}),
		);

		if (!deleted) {
			return jsonError(c, 404, 'Key not found');
		}

		emitAudit(c, {
			action: 'delete_key',
			entity_type: 'key',
			entity_id: keyId,
			detail: JSON.stringify({ name: existing.key.name, zone_id: existing.key.zone_id }),
		});

		return c.json({ success: true, result: { deleted: true } });
	}

	const revoked = await stub.revokeKey(keyId);

	console.log(
		JSON.stringify({
			route: 'admin.revokeKey',
			zoneId: existing.key.zone_id,
			keyId: keyId.slice(0, 12) + '...',
			revoked,
			ts: new Date().toISOString(),
		}),
	);

	if (!revoked) {
		return jsonError(c, 404, 'Key not found or already revoked');
	}

	emitAudit(c, {
		action: 'revoke_key',
		entity_type: 'key',
		entity_id: keyId,
		detail: JSON.stringify({ name: existing.key.name, zone_id: existing.key.zone_id }),
	});

	return c.json({ success: true, result: { revoked: true } });
});

// ─── Bulk revoke ────────────────────────────────────────────────────────────

adminKeysApp.post('/bulk-revoke', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkRevokeKeys', ts: new Date().toISOString() };

	const body = await parseBulkBody(c, 'ids', log);
	if (body instanceof Response) return body;

	const { ids, dryRun } = body;
	const stub = getStub(c.env);

	if (dryRun) {
		const preview = await stub.bulkInspectKeys(ids, 'revoked');
		log.status = 200;
		log.dryRun = true;
		log.count = ids.length;
		console.log(JSON.stringify(log));
		return c.json({ success: true, result: preview });
	}

	const result = await stub.bulkRevokeKeys(ids);
	log.status = 200;
	log.processed = result.processed;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'bulk_revoke_keys',
		entity_type: 'key',
		entity_id: null,
		detail: JSON.stringify({ ids, processed: result.processed }),
	});

	return c.json({ success: true, result });
});

// ─── Bulk delete ────────────────────────────────────────────────────────────

adminKeysApp.post('/bulk-delete', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkDeleteKeys', ts: new Date().toISOString() };

	const body = await parseBulkBody(c, 'ids', log);
	if (body instanceof Response) return body;

	const { ids, dryRun } = body;
	const stub = getStub(c.env);

	if (dryRun) {
		const preview = await stub.bulkInspectKeys(ids, 'deleted');
		log.status = 200;
		log.dryRun = true;
		log.count = ids.length;
		console.log(JSON.stringify(log));
		return c.json({ success: true, result: preview });
	}

	const result = await stub.bulkDeleteKeys(ids);
	log.status = 200;
	log.processed = result.processed;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'bulk_delete_keys',
		entity_type: 'key',
		entity_id: null,
		detail: JSON.stringify({ ids, processed: result.processed }),
	});

	return c.json({ success: true, result });
});

// ─── Private helpers ────────────────────────────────────────────────────────

/** Extract rate_limit fields that have values. Returns undefined if all fields are null/undefined. */
function validateRateLimitFields(raw: NonNullable<CreateKeyRequest['rate_limit']>): CreateKeyRequest['rate_limit'] | undefined {
	const fields = ['bulk_rate', 'bulk_bucket', 'single_rate', 'single_bucket'] as const;
	const result: Record<string, number | undefined> = {};
	let hasAny = false;
	for (const field of fields) {
		const val = raw[field];
		if (val != null) {
			result[field] = val;
			hasAny = true;
		}
	}
	if (!hasAny) return undefined;
	return result as unknown as CreateKeyRequest['rate_limit'];
}

/** Validate per-key rate limits against account defaults. Returns error string or null. */
function validateRateLimits(rl: NonNullable<CreateKeyRequest['rate_limit']>, config: GatewayConfig): string | null {
	const errors: string[] = [];
	if (rl.bulk_rate != null && rl.bulk_rate > config.bulk_rate) {
		errors.push(`bulk_rate ${rl.bulk_rate} exceeds account default ${config.bulk_rate}`);
	}
	if (rl.bulk_bucket != null && rl.bulk_bucket > config.bulk_bucket_size) {
		errors.push(`bulk_bucket ${rl.bulk_bucket} exceeds account default ${config.bulk_bucket_size}`);
	}
	if (rl.single_rate != null && rl.single_rate > config.single_rate) {
		errors.push(`single_rate ${rl.single_rate} exceeds account default ${config.single_rate}`);
	}
	if (rl.single_bucket != null && rl.single_bucket > config.single_bucket_size) {
		errors.push(`single_bucket ${rl.single_bucket} exceeds account default ${config.single_bucket_size}`);
	}
	if (errors.length > 0) {
		return `Per-key rate limits must not exceed account defaults: ${errors.join('; ')}`;
	}
	return null;
}
