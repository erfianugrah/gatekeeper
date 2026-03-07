import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { CONFIG_DEFAULTS } from '../config-registry';
import { invalidateConfigCache } from '../config-cache';
import { setConfigBodySchema, configKeyParamSchema, jsonError, parseJsonBody, parseParams } from './admin-schemas';
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

	const parsed = await parseJsonBody(c, setConfigBodySchema, log);
	if (parsed instanceof Response) return parsed;

	const identity = c.get('accessIdentity');
	const updatedBy = identity?.email ?? undefined;

	const stub = getStub(c.env);
	const config = await stub.setConfig(parsed, updatedBy);
	invalidateConfigCache();

	log.status = 200;
	log.updatedKeys = Object.keys(parsed);
	log.updatedBy = updatedBy;
	console.log(JSON.stringify(log));

	return c.json({ success: true, result: { config } });
});

// ─── Reset config key ───────────────────────────────────────────────────────

/** Delete a config override, reverting to env/default. */
adminConfigApp.delete('/:key', async (c) => {
	const params = parseParams(c, configKeyParamSchema);
	if (params instanceof Response) return params;

	const log: Record<string, unknown> = {
		route: 'admin.resetConfig',
		key: params.key,
		ts: new Date().toISOString(),
	};

	const stub = getStub(c.env);
	const { deleted, config } = await stub.resetConfigKey(params.key);
	invalidateConfigCache();

	log.status = deleted ? 200 : 404;
	log.deleted = deleted;
	console.log(JSON.stringify(log));

	if (!deleted) {
		return jsonError(c, 404, `No override found for key: ${params.key}`);
	}

	return c.json({ success: true, result: { config } });
});
