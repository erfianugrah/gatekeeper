import { Hono } from 'hono';
import { validatePolicy } from '../policy-engine';
import { getStub } from '../do-stub';
import { queryS3Events, queryS3Summary } from '../s3/analytics';
import type { S3AnalyticsQuery } from '../s3/analytics';
import type { HonoEnv } from '../types';
import type { PolicyDocument } from '../policy-types';
import type { CreateS3CredentialRequest } from '../s3/types';

// ─── Admin: S3 Credential Management ────────────────────────────────────────

export const adminS3App = new Hono<HonoEnv>();

// ─── Create credential ──────────────────────────────────────────────────────

adminS3App.post('/credentials', async (c) => {
	const log: Record<string, unknown> = {
		route: 'admin.createS3Credential',
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

	const req: CreateS3CredentialRequest = {
		name: raw.name as string,
		policy: raw.policy as PolicyDocument,
		created_by: typeof raw.created_by === 'string' ? raw.created_by : undefined,
		expires_in_days: typeof raw.expires_in_days === 'number' ? raw.expires_in_days : undefined,
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
	const statusFilter = c.req.query('status') as 'active' | 'revoked' | undefined;
	const validFilters = ['active', 'revoked'];
	const filter = statusFilter && validFilters.includes(statusFilter) ? statusFilter : undefined;

	const stub = getStub(c.env);
	const credentials = await stub.listS3Credentials(filter);

	console.log(JSON.stringify({
		route: 'admin.listS3Credentials',
		filter: filter ?? 'all',
		count: credentials.length,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: credentials });
});

// ─── Get credential ─────────────────────────────────────────────────────────

adminS3App.get('/credentials/:id', async (c) => {
	const accessKeyId = c.req.param('id');
	const stub = getStub(c.env);
	const result = await stub.getS3Credential(accessKeyId);

	if (!result) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: 'Credential not found' }] },
			404,
		);
	}

	return c.json({ success: true, result });
});

// ─── Revoke credential ──────────────────────────────────────────────────────

adminS3App.delete('/credentials/:id', async (c) => {
	const accessKeyId = c.req.param('id');
	const stub = getStub(c.env);

	const existing = await stub.getS3Credential(accessKeyId);
	if (!existing) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: 'Credential not found or already revoked' }] },
			404,
		);
	}

	const revoked = await stub.revokeS3Credential(accessKeyId);

	console.log(JSON.stringify({
		route: 'admin.revokeS3Credential',
		accessKeyId,
		revoked,
		ts: new Date().toISOString(),
	}));

	if (!revoked) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: 'Credential not found or already revoked' }] },
			404,
		);
	}

	return c.json({ success: true, result: { revoked: true } });
});

// ─── S3 Analytics: events ───────────────────────────────────────────────────

adminS3App.get('/analytics/events', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		return c.json(
			{ success: false, errors: [{ code: 503, message: 'Analytics not configured' }] },
			503,
		);
	}

	const query: S3AnalyticsQuery = {
		credential_id: c.req.query('credential_id') || undefined,
		bucket: c.req.query('bucket') || undefined,
		operation: c.req.query('operation') || undefined,
		since: c.req.query('since') ? Number(c.req.query('since')) : undefined,
		until: c.req.query('until') ? Number(c.req.query('until')) : undefined,
		limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
	};

	const events = await queryS3Events(c.env.ANALYTICS_DB, query);

	console.log(JSON.stringify({
		route: 'admin.s3Analytics.events',
		count: events.length,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: events });
});

// ─── S3 Analytics: summary ──────────────────────────────────────────────────

adminS3App.get('/analytics/summary', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		return c.json(
			{ success: false, errors: [{ code: 503, message: 'Analytics not configured' }] },
			503,
		);
	}

	const query: S3AnalyticsQuery = {
		credential_id: c.req.query('credential_id') || undefined,
		bucket: c.req.query('bucket') || undefined,
		operation: c.req.query('operation') || undefined,
		since: c.req.query('since') ? Number(c.req.query('since')) : undefined,
		until: c.req.query('until') ? Number(c.req.query('until')) : undefined,
	};

	const summary = await queryS3Summary(c.env.ANALYTICS_DB, query);

	console.log(JSON.stringify({
		route: 'admin.s3Analytics.summary',
		totalRequests: summary.total_requests,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: summary });
});
