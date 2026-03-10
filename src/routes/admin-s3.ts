import { Hono } from 'hono';
import { validatePolicy } from '../policy-engine';
import { getStub } from '../do-stub';
import { resolveCreatedBy, emitAudit } from './admin-helpers';
import { validateR2Binding } from './r2-binding';
import {
	createS3CredentialSchema,
	rotateS3CredentialSchema,
	updateS3CredentialSchema,
	listS3CredentialsQuerySchema,
	deleteQuerySchema,
	idParamSchema,
	s3AnalyticsEventsQuerySchema,
	s3AnalyticsSummaryQuerySchema,
	s3TimeseriesQuerySchema,
	jsonError,
	parseJsonBody,
	parseQueryParams,
	parseParams,
	parseBulkBody,
} from './admin-schemas';
import type { HonoEnv } from '../types';
import type { PolicyDocument } from '../policy-types';
import type { CreateS3CredentialRequest } from '../s3/types';
import type { S3AnalyticsQuery } from '../s3/analytics';
import { queryS3Events, queryS3Summary } from '../s3/analytics';
import { queryTimeseries } from '../analytics-timeseries';

// ─── Admin: S3 Credential Management ────────────────────────────────────────

export const adminS3App = new Hono<HonoEnv>();

// ─── Create credential ──────────────────────────────────────────────────────

adminS3App.post('/credentials', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.createS3Credential',
		ts: new Date().toISOString(),
	};

	const parsed = await parseJsonBody(c, createS3CredentialSchema, log);
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

	// Validate upstream R2 endpoint binding — resources must match endpoint's bucket scope
	const bindingResult = await validateR2Binding(stub, parsed.upstream_token_id, parsed.policy as PolicyDocument);
	if (!bindingResult.valid) {
		log.status = 400;
		log.error = 'r2_binding_invalid';
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

	const identity = c.get('accessIdentity');
	const req: CreateS3CredentialRequest = {
		name: parsed.name,
		policy: parsed.policy as PolicyDocument,
		created_by: resolveCreatedBy(identity, parsed.created_by),
		expires_in_days: parsed.expires_in_days,
		upstream_token_id: parsed.upstream_token_id,
	};

	log.credentialName = req.name;
	log.statementCount = req.policy.statements.length;

	const result = await stub.createS3Credential(req);

	log.status = 200;
	log.accessKeyId = result.credential.access_key_id;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'create_s3_credential',
		entity_type: 's3_credential',
		entity_id: result.credential.access_key_id,
		detail: JSON.stringify({ name: req.name, upstream_token_id: req.upstream_token_id }),
	});

	return c.json({ success: true, result });
});

// ─── List credentials ───────────────────────────────────────────────────────

adminS3App.get('/credentials', async (c) => {
	const query = parseQueryParams(c, listS3CredentialsQuerySchema);
	if (query instanceof Response) return query;

	const stub = getStub(c.env);
	const credentials = await stub.listS3Credentials(query.status);

	console.log(
		JSON.stringify({
			route: 'admin.listS3Credentials',
			filter: query.status ?? 'all',
			count: credentials.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: credentials });
});

// ─── Get credential ─────────────────────────────────────────────────────────

adminS3App.get('/credentials/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const stub = getStub(c.env);
	const result = await stub.getS3Credential(params.id);

	if (!result) {
		console.log(JSON.stringify({ breadcrumb: 'admin-get-s3-credential-not-found', id: params.id }));
		return jsonError(c, 404, 'Credential not found');
	}

	return c.json({ success: true, result });
});

// ─── Rotate credential ──────────────────────────────────────────────────────

adminS3App.post('/credentials/:id/rotate', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.rotateS3Credential',
		ts: new Date().toISOString(),
	};

	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const parsed = await parseJsonBody(c, rotateS3CredentialSchema, log);
	if (parsed instanceof Response) return parsed;

	const stub = getStub(c.env);
	const result = await stub.rotateS3Credential(params.id, {
		name: parsed.name,
		expires_in_days: parsed.expires_in_days,
	});

	if (!result) {
		log.status = 404;
		log.error = 'credential_not_found_or_inactive';
		console.log(JSON.stringify(log));
		return jsonError(c, 404, 'Credential not found, already revoked, or expired');
	}

	log.status = 200;
	log.oldAccessKeyId = result.oldCredential.access_key_id;
	log.newAccessKeyId = result.newCredential.access_key_id;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'rotate_s3_credential',
		entity_type: 's3_credential',
		entity_id: result.newCredential.access_key_id,
		detail: JSON.stringify({
			old_access_key_id: result.oldCredential.access_key_id,
			new_access_key_id: result.newCredential.access_key_id,
		}),
	});

	return c.json({
		success: true,
		result: {
			old_credential: result.oldCredential,
			new_credential: result.newCredential,
		},
	});
});

// ─── Update credential ──────────────────────────────────────────────────────

adminS3App.patch('/credentials/:id', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.updateS3Credential',
		ts: new Date().toISOString(),
	};

	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const parsed = await parseJsonBody(c, updateS3CredentialSchema, log);
	if (parsed instanceof Response) return parsed;

	const updates: Record<string, unknown> = {};
	if (parsed.name !== undefined) updates.name = parsed.name;
	if (parsed.expires_at !== undefined) updates.expires_at = parsed.expires_at;

	const stub = getStub(c.env);
	const result = await stub.updateS3Credential(params.id, updates as Parameters<typeof stub.updateS3Credential>[1]);

	if (!result) {
		log.status = 404;
		log.error = 'credential_not_found_or_revoked';
		console.log(JSON.stringify(log));
		return jsonError(c, 404, 'Credential not found or already revoked');
	}

	log.status = 200;
	log.accessKeyId = params.id;
	log.updatedFields = Object.keys(updates);
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'update_s3_credential',
		entity_type: 's3_credential',
		entity_id: params.id,
		detail: JSON.stringify(updates),
	});

	return c.json({ success: true, result });
});

// ─── Revoke / delete credential ─────────────────────────────────────────────

adminS3App.delete('/credentials/:id', async (c) => {
	const params = parseParams(c, idParamSchema);
	if (params instanceof Response) return params;

	const query = parseQueryParams(c, deleteQuerySchema);
	if (query instanceof Response) return query;

	const accessKeyId = params.id;
	const stub = getStub(c.env);

	const existing = await stub.getS3Credential(accessKeyId);
	if (!existing) {
		return jsonError(c, 404, 'Credential not found');
	}

	if (query.permanent) {
		const deleted = await stub.deleteS3Credential(accessKeyId);

		console.log(
			JSON.stringify({
				route: 'admin.deleteS3Credential',
				accessKeyId,
				deleted,
				ts: new Date().toISOString(),
			}),
		);

		if (!deleted) {
			return jsonError(c, 404, 'Credential not found');
		}

		emitAudit(c, {
			action: 'delete_s3_credential',
			entity_type: 's3_credential',
			entity_id: accessKeyId,
			detail: JSON.stringify({ name: existing.credential.name }),
		});

		return c.json({ success: true, result: { deleted: true } });
	}

	const revoked = await stub.revokeS3Credential(accessKeyId);

	console.log(
		JSON.stringify({
			route: 'admin.revokeS3Credential',
			accessKeyId,
			revoked,
			ts: new Date().toISOString(),
		}),
	);

	if (!revoked) {
		return jsonError(c, 404, 'Credential not found or already revoked');
	}

	emitAudit(c, {
		action: 'revoke_s3_credential',
		entity_type: 's3_credential',
		entity_id: accessKeyId,
		detail: JSON.stringify({ name: existing.credential.name }),
	});

	return c.json({ success: true, result: { revoked: true } });
});

// ─── Bulk revoke credentials ────────────────────────────────────────────────

adminS3App.post('/credentials/bulk-revoke', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkRevokeS3Credentials', ts: new Date().toISOString() };

	const body = await parseBulkBody(c, 'access_key_ids', log);
	if (body instanceof Response) return body;

	const { ids, dryRun } = body;
	const stub = getStub(c.env);

	if (dryRun) {
		const preview = await stub.bulkInspectS3Credentials(ids, 'revoked');
		log.status = 200;
		log.dryRun = true;
		log.count = ids.length;
		console.log(JSON.stringify(log));
		return c.json({ success: true, result: preview });
	}

	const result = await stub.bulkRevokeS3Credentials(ids);
	log.status = 200;
	log.processed = result.processed;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'bulk_revoke_s3_credentials',
		entity_type: 's3_credential',
		entity_id: null,
		detail: JSON.stringify({ ids, processed: result.processed }),
	});

	return c.json({ success: true, result });
});

// ─── Bulk delete credentials ────────────────────────────────────────────────

adminS3App.post('/credentials/bulk-delete', async (c) => {
	const log: Record<string, unknown> = { route: 'admin.bulkDeleteS3Credentials', ts: new Date().toISOString() };

	const body = await parseBulkBody(c, 'access_key_ids', log);
	if (body instanceof Response) return body;

	const { ids, dryRun } = body;
	const stub = getStub(c.env);

	if (dryRun) {
		const preview = await stub.bulkInspectS3Credentials(ids, 'deleted');
		log.status = 200;
		log.dryRun = true;
		log.count = ids.length;
		console.log(JSON.stringify(log));
		return c.json({ success: true, result: preview });
	}

	const result = await stub.bulkDeleteS3Credentials(ids);
	log.status = 200;
	log.processed = result.processed;
	console.log(JSON.stringify(log));

	emitAudit(c, {
		action: 'bulk_delete_s3_credentials',
		entity_type: 's3_credential',
		entity_id: null,
		detail: JSON.stringify({ ids, processed: result.processed }),
	});

	return c.json({ success: true, result });
});

// ─── S3 Analytics: events ───────────────────────────────────────────────────

adminS3App.get('/analytics/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 's3-events' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, s3AnalyticsEventsQuerySchema);
	if (query instanceof Response) return query;

	const s3Query: S3AnalyticsQuery = {
		credential_id: query.credential_id,
		bucket: query.bucket,
		operation: query.operation,
		since: query.since,
		until: query.until,
		limit: query.limit,
	};

	const events = await queryS3Events(c.env.ANALYTICS_DB, s3Query);

	console.log(
		JSON.stringify({
			route: 'admin.s3Analytics.events',
			count: events.length,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: events });
});

// ─── S3 Analytics: summary ──────────────────────────────────────────────────

adminS3App.get('/analytics/summary', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 's3-summary' }));
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, s3AnalyticsSummaryQuerySchema);
	if (query instanceof Response) return query;

	const s3Query: S3AnalyticsQuery = {
		credential_id: query.credential_id,
		bucket: query.bucket,
		operation: query.operation,
		since: query.since,
		until: query.until,
	};

	const summary = await queryS3Summary(c.env.ANALYTICS_DB, s3Query);

	console.log(
		JSON.stringify({
			route: 'admin.s3Analytics.summary',
			totalRequests: summary.total_requests,
			ts: new Date().toISOString(),
		}),
	);

	return c.json({ success: true, result: summary });
});

// ─── S3 Analytics: timeseries ───────────────────────────────────────────────

adminS3App.get('/analytics/timeseries', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		return jsonError(c, 503, 'Analytics not configured');
	}

	const query = parseQueryParams(c, s3TimeseriesQuerySchema);
	if (query instanceof Response) return query;

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.credential_id) {
		conditions.push('credential_id = ?');
		params.push(query.credential_id);
	}
	if (query.bucket) {
		conditions.push('bucket = ?');
		params.push(query.bucket);
	}
	if (query.operation) {
		conditions.push('operation = ?');
		params.push(query.operation);
	}

	const buckets = await queryTimeseries(
		c.env.ANALYTICS_DB,
		's3_events',
		{ conditions, params },
		{ since: query.since, until: query.until },
	);

	return c.json({ success: true, result: buckets });
});
