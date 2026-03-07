import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { CONFIG_DEFAULTS } from '../config-registry';
import type { HonoEnv } from '../types';

// ─── Admin: Config Registry Management ──────────────────────────────────────

export const adminConfigApp = new Hono<HonoEnv>();

// ─── Get config ─────────────────────────────────────────────────────────────

/** Returns the full resolved config, overrides, and defaults for admin display. */
adminConfigApp.get('/', async (c) => {
	const stub = getStub(c.env);
	const [config, overrides] = await Promise.all([stub.getConfig(), stub.listConfigOverrides()]);

	console.log(
		JSON.stringify({
			route: 'admin.getConfig',
			overrideCount: overrides.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({
		success: true,
		result: {
			config,
			overrides,
			defaults: CONFIG_DEFAULTS,
		},
	});
});

// ─── Set config ─────────────────────────────────────────────────────────────

/** Set one or more config values. Body: { "key": value, ... } */
adminConfigApp.put('/', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.setConfig',
		ts: new Date().toISOString(),
	};

	let raw: Record<string, unknown>;
	try {
		raw = await c.req.json<Record<string, unknown>>();
	} catch {
		log.status = 400;
		log.error = 'invalid_json';
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Invalid JSON body' }] }, 400);
	}

	// Validate all keys and values before applying
	const updates: Record<string, number> = {};
	const errors: string[] = [];

	for (const [key, value] of Object.entries(raw)) {
		if (!(key in CONFIG_DEFAULTS)) {
			errors.push(`Unknown config key: ${key}`);
			continue;
		}
		if (typeof value !== 'number' || value <= 0 || !isFinite(value)) {
			errors.push(`${key}: must be a positive finite number`);
			continue;
		}
		updates[key] = value;
	}

	if (errors.length > 0) {
		log.status = 400;
		log.error = 'validation_failed';
		log.validationErrors = errors;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: errors.map((e) => ({ code: 400, message: e })),
			},
			400,
		);
	}

	if (Object.keys(updates).length === 0) {
		log.status = 400;
		log.error = 'empty_body';
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Request body must contain at least one config key' }] }, 400);
	}

	const identity = c.get('accessIdentity');
	const updatedBy = identity?.email ?? undefined;

	const stub = getStub(c.env);
	const config = await stub.setConfig(updates, updatedBy);

	log.status = 200;
	log.updatedKeys = Object.keys(updates);
	log.updatedBy = updatedBy;
	console.log(JSON.stringify(log));

	return c.json({ success: true, result: { config } });
});

// ─── Reset config key ───────────────────────────────────────────────────────

/** Delete a config override, reverting to env/default. */
adminConfigApp.delete('/:key', async (c) => {
	const key = c.req.param('key');
	const log: Record<string, unknown> = {
		route: 'admin.resetConfig',
		key,
		ts: new Date().toISOString(),
	};

	if (!(key in CONFIG_DEFAULTS)) {
		log.status = 400;
		log.error = 'unknown_key';
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: `Unknown config key: ${key}` }] }, 400);
	}

	const stub = getStub(c.env);
	const { deleted, config } = await stub.resetConfigKey(key);

	log.status = deleted ? 200 : 404;
	log.deleted = deleted;
	console.log(JSON.stringify(log));

	if (!deleted) {
		return c.json({ success: false, errors: [{ code: 404, message: `No override found for key: ${key}` }] }, 404);
	}

	return c.json({ success: true, result: { config } });
});
