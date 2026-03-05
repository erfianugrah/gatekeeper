import { Hono } from 'hono';
import { validatePolicy } from '../policy-engine';
import { parseConfig } from '../durable-object';
import { getStub } from '../do-stub';
import type { CreateKeyRequest, HonoEnv } from '../types';
import type { PolicyDocument } from '../policy-types';

// ─── Admin: Purge Key Management ────────────────────────────────────────────

export const adminKeysApp = new Hono<HonoEnv>();

// ─── Create key ─────────────────────────────────────────────────────────────

adminKeysApp.post('/', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.createKey',
		ts: new Date().toISOString(),
	};

	let raw: Record<string, unknown>;
	try {
		raw = await c.req.json<Record<string, unknown>>();
	} catch {
		log.status = 400;
		log.error = 'invalid_json';
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'Invalid JSON body' }] },
			400,
		);
	}

	if (!raw.name || typeof raw.name !== 'string') {
		log.status = 400;
		log.error = 'missing_name';
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'Required field: name (string)' }] },
			400,
		);
	}
	if (!raw.zone_id || typeof raw.zone_id !== 'string') {
		log.status = 400;
		log.error = 'missing_zone_id';
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'Required field: zone_id (string)' }] },
			400,
		);
	}

	if (!raw.policy || typeof raw.policy !== 'object') {
		log.status = 400;
		log.error = 'missing_policy';
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'Required field: policy (object with version + statements)' }] },
			400,
		);
	}

	const policyErrors = validatePolicy(raw.policy);
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

	const rateLimit = raw.rate_limit as CreateKeyRequest['rate_limit'] | undefined;
	if (rateLimit) {
		const rateLimitError = validateRateLimits(rateLimit, c.env);
		if (rateLimitError) {
			log.status = 400;
			log.error = 'rate_limit_exceeds_account';
			console.log(JSON.stringify(log));
			return c.json(
				{ success: false, errors: [{ code: 400, message: rateLimitError }] },
				400,
			);
		}
	}

	const req: CreateKeyRequest = {
		name: raw.name as string,
		zone_id: raw.zone_id as string,
		policy: raw.policy as PolicyDocument,
		created_by: typeof raw.created_by === 'string' ? raw.created_by : undefined,
		expires_in_days: typeof raw.expires_in_days === 'number' ? raw.expires_in_days : undefined,
		rate_limit: rateLimit,
	};

	log.zoneId = req.zone_id;
	log.keyName = req.name;
	log.statementCount = req.policy.statements.length;

	const stub = getStub(c.env);
	const result = await stub.createKey(req);

	log.status = 200;
	log.keyId = result.key.id.slice(0, 12) + '...';
	console.log(JSON.stringify(log));

	return c.json({ success: true, result });
});

// ─── List keys ──────────────────────────────────────────────────────────────

adminKeysApp.get('/', async (c) => {
	const zoneId = c.req.query('zone_id');
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'zone_id query param required' }] },
			400,
		);
	}

	const statusFilter = c.req.query('status') as 'active' | 'revoked' | undefined;
	const validFilters = ['active', 'revoked'];
	const filter = statusFilter && validFilters.includes(statusFilter) ? statusFilter : undefined;

	const stub = getStub(c.env);
	const keys = await stub.listKeys(zoneId, filter);

	console.log(JSON.stringify({
		route: 'admin.listKeys',
		zoneId,
		filter: filter ?? 'all',
		count: keys.length,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: keys });
});

// ─── Get key ────────────────────────────────────────────────────────────────

adminKeysApp.get('/:id', async (c) => {
	const zoneId = c.req.query('zone_id');
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'zone_id query param required' }] },
			400,
		);
	}

	const keyId = c.req.param('id');
	const stub = getStub(c.env);
	const result = await stub.getKey(keyId);

	if (!result || result.key.zone_id !== zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: 'Key not found' }] },
			404,
		);
	}

	return c.json({ success: true, result });
});

// ─── Revoke key ─────────────────────────────────────────────────────────────

adminKeysApp.delete('/:id', async (c) => {
	const zoneId = c.req.query('zone_id');
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'zone_id query param required' }] },
			400,
		);
	}

	const keyId = c.req.param('id');
	const stub = getStub(c.env);

	const existing = await stub.getKey(keyId);
	if (!existing || existing.key.zone_id !== zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: 'Key not found or already revoked' }] },
			404,
		);
	}

	const revoked = await stub.revokeKey(keyId);

	const log: Record<string, unknown> = {
		route: 'admin.revokeKey',
		zoneId,
		keyId: keyId.slice(0, 12) + '...',
		revoked,
		ts: new Date().toISOString(),
	};
	console.log(JSON.stringify(log));

	if (!revoked) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: 'Key not found or already revoked' }] },
			404,
		);
	}

	return c.json({ success: true, result: { revoked: true } });
});

// ─── Private helpers ────────────────────────────────────────────────────────

/** Validate per-key rate limits against account defaults. Returns error string or null. */
function validateRateLimits(rl: NonNullable<CreateKeyRequest['rate_limit']>, env: Env): string | null {
	const config = parseConfig(env);
	const errors: string[] = [];
	if (rl.bulk_rate != null && rl.bulk_rate > config.bulk.rate) {
		errors.push(`bulk_rate ${rl.bulk_rate} exceeds account default ${config.bulk.rate}`);
	}
	if (rl.bulk_bucket != null && rl.bulk_bucket > config.bulk.bucketSize) {
		errors.push(`bulk_bucket ${rl.bulk_bucket} exceeds account default ${config.bulk.bucketSize}`);
	}
	if (rl.single_rate != null && rl.single_rate > config.single.rate) {
		errors.push(`single_rate ${rl.single_rate} exceeds account default ${config.single.rate}`);
	}
	if (rl.single_bucket != null && rl.single_bucket > config.single.bucketSize) {
		errors.push(`single_bucket ${rl.single_bucket} exceeds account default ${config.single.bucketSize}`);
	}
	if (errors.length > 0) {
		return `Per-key rate limits must not exceed account defaults: ${errors.join('; ')}`;
	}
	return null;
}
