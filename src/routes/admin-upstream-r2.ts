import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { resolveCreatedBy, validateR2Credentials, emitAudit } from './admin-helpers';
import {
	createUpstreamR2Schema,
	updateUpstreamR2Schema,
	idParamSchema,
	jsonError,
	parseJsonBody,
	parseParams,
	parseBulkBody,
} from './admin-schemas';
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

	const parsed = await parseJsonBody(c, createUpstreamR2Schema, log);
	if (parsed instanceof Response) return parsed;

	// Optional validation: probe R2 with ListBuckets to check credentials
	const warnings: ValidationWarning[] = [];
	if (parsed.validate === true) {
		const warning = await validateR2Credentials(parsed.access_key_id, parsed.secret_access_key, parsed.endpoint);
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
		name: parsed.name,
		access_key_id: parsed.access_key_id,
		secret_access_key: parsed.secret_access_key,
		endpoint: parsed.endpoint,
		bucket_names: parsed.bucket_names,
		expires_in_days: parsed.expires_in_days,
		created_by: resolveCreatedBy(identity, parsed.created_by),
	});

	log.status = 200;
	log.endpointId = result.endpoint.id;
	log.bucketNames = parsed.bucket_names;
	if (parsed.expires_in_days) log.expiresInDays = parsed.expires_in_days;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'create_upstream_r2',
		entity_type: 'upstream_r2',
		entity_id: result.endpoint.id,
		detail: JSON.stringify({
			name: parsed.name,
			bucket_names: parsed.bucket_names,
			...(parsed.expires_in_days && { expires_in_days: parsed.expires_in_days }),
		}),
	});

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
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const stub = getStub(c.env);
	const result = await stub.getUpstreamR2(params.id);

	if (!result) {
		console.log(JSON.stringify({ breadcrumb: 'admin-get-upstream-r2-not-found', id: params.id }));
		return jsonError(c, 404, 'Upstream R2 endpoint not found');
	}

	return c.json({ success: true, result: result.endpoint });
});

// ─── Update ─────────────────────────────────────────────────────────────────

adminUpstreamR2App.patch('/:id', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.updateUpstreamR2', ts: new Date().toISOString() };

	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const parsed = await parseJsonBody(c, updateUpstreamR2Schema, log);
	if (parsed instanceof Response) return parsed;

	const stub = getStub(c.env);
	const result = await stub.updateUpstreamR2(params.id, parsed);

	if (!result) {
		log.status = 404;
		console.log(JSON.stringify(log));
		return jsonError(c, 404, 'Upstream R2 endpoint not found');
	}

	log.status = 200;
	log.endpointId = params.id;
	log.updatedFields = Object.keys(parsed);
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'update_upstream_r2',
		entity_type: 'upstream_r2',
		entity_id: params.id,
		detail: JSON.stringify(parsed),
	});

	return c.json({ success: true, result: result.endpoint });
});

// ─── Delete ─────────────────────────────────────────────────────────────────

adminUpstreamR2App.delete('/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const stub = getStub(c.env);

	// Check for bound S3 credentials — warn but don't block
	const boundCredentialCount = await stub.countS3CredentialsByUpstreamToken(params.id);

	const deleted = await stub.deleteUpstreamR2(params.id);

	console.log(
		JSON.stringify({
			route: 'admin.deleteUpstreamR2',
			endpointId: params.id,
			deleted,
			boundCredentialCount,
			ts: new Date().toISOString(),
		}),
	);

	if (!deleted) {
		return jsonError(c, 404, 'Upstream R2 endpoint not found');
	}

	emitAudit(c, {
		action: 'delete_upstream_r2',
		entity_type: 'upstream_r2',
		entity_id: params.id,
		detail: boundCredentialCount > 0 ? JSON.stringify({ orphaned_credentials: boundCredentialCount }) : null,
	});

	const warnings: { type: string; message: string }[] = [];
	if (boundCredentialCount > 0) {
		warnings.push({
			type: 'orphaned_credentials',
			message: `${boundCredentialCount} active S3 credential(s) were bound to this R2 endpoint and will no longer be able to reach upstream`,
		});
	}

	return c.json({ success: true, result: { deleted: true }, ...(warnings.length > 0 && { warnings }) });
});

// ─── Bulk delete ────────────────────────────────────────────────────────────

adminUpstreamR2App.post('/bulk-delete', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkDeleteUpstreamR2', ts: new Date().toISOString() };

	const body = await parseBulkBody(c, 'ids', log);
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

	emitAudit(c, {
		action: 'bulk_delete_upstream_r2',
		entity_type: 'upstream_r2',
		entity_id: null,
		detail: JSON.stringify({ ids, processed: result.processed }),
	});

	return c.json({ success: true, result });
});
