import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { parseBulkBody, resolveCreatedBy, validateR2Credentials } from './admin-helpers';
import type { ValidationWarning } from './admin-helpers';
import type { HonoEnv } from '../types';

// ─── Admin: Upstream R2 Endpoint Management ─────────────────────────────────

export const adminUpstreamR2App = new Hono<HonoEnv>();

// ─── Create ─────────────────────────────────────────────────────────────────

adminUpstreamR2App.post('/', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.createUpstreamR2',
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
	if (!raw.access_key_id || typeof raw.access_key_id !== 'string') {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Required field: access_key_id (string)' }] }, 400);
	}
	if (!raw.secret_access_key || typeof raw.secret_access_key !== 'string') {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Required field: secret_access_key (string)' }] }, 400);
	}
	if (!raw.endpoint || typeof raw.endpoint !== 'string') {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Required field: endpoint (string URL)' }] }, 400);
	}
	try {
		const parsed = new URL(raw.endpoint);
		if (parsed.protocol !== 'https:') {
			log.status = 400;
			console.log(JSON.stringify(log));
			return c.json({ success: false, errors: [{ code: 400, message: 'endpoint must be an HTTPS URL' }] }, 400);
		}
	} catch {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'endpoint must be a valid URL' }] }, 400);
	}
	if (!Array.isArray(raw.bucket_names) || raw.bucket_names.length === 0 || !raw.bucket_names.every((b: unknown) => typeof b === 'string')) {
		log.status = 400;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: [{ code: 400, message: 'Required field: bucket_names (non-empty array of strings, or ["*"])' }],
			},
			400,
		);
	}

	// Optional validation: probe R2 with ListBuckets to check credentials
	const warnings: ValidationWarning[] = [];
	if (raw.validate === true) {
		const warning = await validateR2Credentials(raw.access_key_id as string, raw.secret_access_key as string, raw.endpoint as string);
		if (warning) {
			warnings.push(warning);
			log.validationFailed = true;
		} else {
			log.validated = true;
		}
	}

	const identity = c.get('accessIdentity');
	const stub = getStub(c.env);
	const result = await stub.createUpstreamR2({
		name: raw.name,
		access_key_id: raw.access_key_id,
		secret_access_key: raw.secret_access_key,
		endpoint: raw.endpoint,
		bucket_names: raw.bucket_names as string[],
		created_by: resolveCreatedBy(identity, raw.created_by),
	});

	log.status = 200;
	log.endpointId = result.endpoint.id;
	log.bucketNames = raw.bucket_names;
	console.log(JSON.stringify(log));

	return c.json({ success: true, result: result.endpoint, ...(warnings.length > 0 && { warnings }) });
});

// ─── List ───────────────────────────────────────────────────────────────────

adminUpstreamR2App.get('/', async (c) => {
	const stub = getStub(c.env);
	const endpoints = await stub.listUpstreamR2();

	console.log(
		JSON.stringify({
			route: 'admin.listUpstreamR2',
			count: endpoints.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: endpoints });
});

// ─── Get ────────────────────────────────────────────────────────────────────

adminUpstreamR2App.get('/:id', async (c) => {
	const id = c.req.param('id');
	const stub = getStub(c.env);
	const result = await stub.getUpstreamR2(id);

	if (!result) {
		return c.json({ success: false, errors: [{ code: 404, message: 'Upstream R2 endpoint not found' }] }, 404);
	}

	return c.json({ success: true, result: result.endpoint });
});

// ─── Delete ─────────────────────────────────────────────────────────────────

adminUpstreamR2App.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const stub = getStub(c.env);
	const deleted = await stub.deleteUpstreamR2(id);

	console.log(
		JSON.stringify({
			route: 'admin.deleteUpstreamR2',
			endpointId: id,
			deleted,
			ts: new Date().toISOString(),
		}),
	);

	if (!deleted) {
		return c.json({ success: false, errors: [{ code: 404, message: 'Upstream R2 endpoint not found' }] }, 404);
	}

	return c.json({ success: true, result: { deleted: true } });
});

// ─── Bulk delete ────────────────────────────────────────────────────────────

adminUpstreamR2App.post('/bulk-delete', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkDeleteUpstreamR2', ts: new Date().toISOString() };

	const body = await parseBulkBody(c);
	if (body instanceof Response) return body;

	const { ids, dryRun } = body;
	const stub = getStub(c.env);

	if (dryRun) {
		const preview = await stub.bulkInspectUpstreamR2(ids, 'deleted');
		log.status = 200;
		log.dryRun = true;
		log.count = ids.length;
		console.log(JSON.stringify(log));
		return c.json({ success: true, result: preview });
	}

	const result = await stub.bulkDeleteUpstreamR2(ids);
	log.status = 200;
	log.processed = result.processed;
	console.log(JSON.stringify(log));
	return c.json({ success: true, result });
});
