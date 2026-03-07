import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { parseBulkBody, resolveCreatedBy, validateCfToken } from './admin-helpers';
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

	let raw: Record<string, unknown>;
	try {
		raw = await c.req.json<Record<string, unknown>>();
	} catch {
		log.status = 400;
		log.error = 'invalid_json';
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Invalid JSON body' }] }, 400);
	}

	if (!raw.name || typeof raw.name !== 'string') {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Required field: name (string)' }] }, 400);
	}
	if (!raw.token || typeof raw.token !== 'string') {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Required field: token (string)' }] }, 400);
	}
	if (!Array.isArray(raw.zone_ids) || raw.zone_ids.length === 0 || !raw.zone_ids.every((z: unknown) => typeof z === 'string')) {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: 'Required field: zone_ids (non-empty array of strings, or ["*"])' }] },
			400,
		);
	}

	const ZONE_ID_RE = /^[a-f0-9]{32}$/;
	const zoneIds = raw.zone_ids as string[];
	const invalid = zoneIds.filter((z) => z !== '*' && !ZONE_ID_RE.test(z));
	if (invalid.length > 0) {
		log.status = 400;
		log.invalidZoneIds = invalid;
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: `Invalid zone_id format (expected 32-char hex or "*"): ${invalid.join(', ')}` }] },
			400,
		);
	}

	// Optional validation: probe the CF API to check if the token works
	const warnings: ValidationWarning[] = [];
	if (raw.validate === true) {
		const warning = await validateCfToken(raw.token);
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
		name: raw.name,
		token: raw.token,
		zone_ids: raw.zone_ids as string[],
		created_by: resolveCreatedBy(identity, raw.created_by),
	});

	log.status = 200;
	log.tokenId = result.token.id;
	log.zoneIds = raw.zone_ids;
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
	const id = c.req.param('id');
	const stub = getStub(c.env);
	const result = await stub.getUpstreamToken(id);

	if (!result) {
		return c.json({ success: false, errors: [{ code: 404, message: 'Upstream token not found' }] }, 404);
	}

	return c.json({ success: true, result: result.token });
});

// ─── Delete ─────────────────────────────────────────────────────────────────

adminUpstreamTokensApp.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const stub = getStub(c.env);
	const deleted = await stub.deleteUpstreamToken(id);

	console.log(
		JSON.stringify({
			route: 'admin.deleteUpstreamToken',
			tokenId: id,
			deleted,
			ts: new Date().toISOString(),
		}),
	);

	if (!deleted) {
		return c.json({ success: false, errors: [{ code: 404, message: 'Upstream token not found' }] }, 404);
	}

	return c.json({ success: true, result: { deleted: true } });
});

// ─── Bulk delete ────────────────────────────────────────────────────────────

adminUpstreamTokensApp.post('/bulk-delete', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkDeleteUpstreamTokens', ts: new Date().toISOString() };

	const body = await parseBulkBody(c);
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
