import { Hono } from 'hono';
import { verifySigV4, parseAuthHeader } from './sig-v4-verify';
import { forwardToR2 } from './sig-v4-sign';
import { detectOperation, buildConditionFields } from './operations';
import type { HonoEnv } from '../types';
import type { RequestContext } from '../policy-types';

// ─── DO stub helper ─────────────────────────────────────────────────────────

const DO_NAME = 'account';

function getStub(env: Env) {
	return env.PURGE_RATE_LIMITER.get(
		env.PURGE_RATE_LIMITER.idFromName(DO_NAME),
	);
}

// ─── S3 XML error helpers ───────────────────────────────────────────────────

function s3XmlError(code: string, message: string, status: number, requestId?: string): Response {
	const rid = requestId || crypto.randomUUID();
	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<Error>',
		`<Code>${code}</Code>`,
		`<Message>${escapeXml(message)}</Message>`,
		`<RequestId>${rid}</RequestId>`,
		'</Error>',
	].join('\n');

	return new Response(xml, {
		status,
		headers: {
			'Content-Type': 'application/xml',
			'x-amz-request-id': rid,
		},
	});
}

function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── S3 sub-app ─────────────────────────────────────────────────────────────

export const s3App = new Hono<HonoEnv>();

/** Catch-all handler for all S3 operations at /s3/* */
s3App.all('/*', async (c) => {
	const start = Date.now();
	const url = new URL(c.req.url);

	// The path after /s3 — e.g. /s3/my-bucket/key.txt → /my-bucket/key.txt
	const s3Path = url.pathname.replace(/^\/s3/, '') || '/';

	const log: Record<string, unknown> = {
		route: 's3',
		method: c.req.method,
		path: s3Path,
		ts: new Date().toISOString(),
	};

	// 1. Detect the S3 operation
	const op = detectOperation(c.req.method, s3Path, url.searchParams, c.req.raw.headers);
	log.operation = op.name;
	log.bucket = op.bucket;
	log.key = op.key;

	// 2. Verify Sig V4 — two-step: parse header, fetch secret from DO, then verify
	const stub = getStub(c.env);

	const authHeader = c.req.header('authorization');
	if (!authHeader) {
		log.status = 403;
		log.error = 'missing_auth';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('AccessDenied', 'Missing Authorization header', 403);
	}

	const parsed = parseAuthHeader(authHeader);
	if (!parsed) {
		log.status = 403;
		log.error = 'malformed_auth';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('AccessDenied', 'Malformed Authorization header', 403);
	}

	log.accessKeyId = parsed.accessKeyId;

	// 2b. Fetch the secret from DO
	const secret = await stub.getS3Secret(parsed.accessKeyId);
	if (!secret) {
		log.status = 403;
		log.error = 'invalid_access_key';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', 403);
	}

	// 2c. Now verify the signature with the secret
	const verifyResult = await verifySigV4(c.req.raw, url, () => secret);
	if (!verifyResult.valid) {
		log.status = 403;
		log.error = verifyResult.error;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));

		const errCode = verifyResult.error === 'SignatureDoesNotMatch' ? 'SignatureDoesNotMatch' : 'AccessDenied';
		const errMsg = verifyResult.error === 'SignatureDoesNotMatch'
			? 'The request signature we calculated does not match the signature you provided.'
			: (verifyResult.error || 'Access Denied');
		return s3XmlError(errCode, errMsg, 403);
	}

	// 3. Build request context and authorize via IAM
	const fields = buildConditionFields(op, c.req.method, c.req.raw.headers, url.searchParams);
	const contexts: RequestContext[] = [{
		action: op.action,
		resource: op.resource,
		fields,
	}];

	// For CopyObject, we also need to authorize read on the source
	if (op.name === 'CopyObject' || op.name === 'UploadPartCopy') {
		const sourceBucket = fields.source_bucket;
		const sourceKey = fields.source_key;
		if (typeof sourceBucket === 'string' && typeof sourceKey === 'string') {
			contexts.push({
				action: 's3:GetObject',
				resource: `object:${sourceBucket}/${sourceKey}`,
				fields,
			});
		}
	}

	const authResult = await stub.authorizeS3(parsed.accessKeyId, contexts);
	if (!authResult.authorized) {
		log.status = 403;
		log.error = 'access_denied';
		log.authError = authResult.error;
		log.denied = authResult.denied;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('AccessDenied', authResult.error || 'Access Denied', 403);
	}

	// 4. Forward to R2 — let R2 handle its own errors (501 NotImplemented, 404, etc.)
	try {
		const r2Response = await forwardToR2(c.req.raw, s3Path, c.env);

		log.status = r2Response.status;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));

		// Stream the response back — preserve all headers from R2
		const responseHeaders = new Headers();
		r2Response.headers.forEach((value, name) => {
			// Skip hop-by-hop and CF-internal headers
			if (!name.startsWith('cf-') && name !== 'connection' && name !== 'keep-alive') {
				responseHeaders.set(name, value);
			}
		});

		return new Response(r2Response.body, {
			status: r2Response.status,
			headers: responseHeaders,
		});
	} catch (e: any) {
		log.status = 502;
		log.error = 'upstream_error';
		log.detail = e.message;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('InternalError', 'An internal error occurred while contacting storage.', 502);
	}
});
