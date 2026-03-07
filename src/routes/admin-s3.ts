import { Hono } from 'hono';
import { validatePolicy } from '../policy-engine';
import { getStub } from '../do-stub';
import { resolveCreatedBy } from './admin-helpers';
import {
	createS3CredentialSchema,
	listS3CredentialsQuerySchema,
	deleteQuerySchema,
	idParamSchema,
	s3AnalyticsEventsQuerySchema,
	s3AnalyticsSummaryQuerySchema,
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

	const identity = c.get('accessIdentity');
	const req: CreateS3CredentialRequest = {
		name: parsed.name,
		policy: parsed.policy as PolicyDocument,
		created_by: resolveCreatedBy(identity, parsed.created_by),
		expires_in_days: parsed.expires_in_days,
	};

	log.credentialName = req.name;
	log.statementCount = req.policy.statements.length;

	const stub = getStub(c.env);
	const result = await stub.createS3Credential(req);

	log.status = 200;
	log.accessKeyId = result.credential.access_key_id;
	console.log(JSON.stringify(log));

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
