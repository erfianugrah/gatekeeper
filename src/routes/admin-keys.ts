import { Hono } from 'hono';
import { validatePolicy } from '../policy-engine';
import { getStub } from '../do-stub';
import { resolveCreatedBy } from './admin-helpers';
import {
	createKeySchema,
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

// ─── Admin: Purge Key Management ────────────────────────────────────────────

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
	};

	log.zoneId = req.zone_id ?? 'none';
	log.keyName = req.name;
	log.statementCount = req.policy.statements.length;
	const result = await stub.createKey(req);

	log.status = 200;
	log.keyId = result.key.id.slice(0, 12) + '...';
	console.log(JSON.stringify(log));

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
		return jsonError(c, 404, 'Key not found');
	}

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
