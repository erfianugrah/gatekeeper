import { Hono } from 'hono';
import { verifySigV4, verifySigV4Presigned, parseAuthHeader, isPresignedUrl, parsePresignedParams } from './sig-v4-verify';
import { forwardToR2 } from './sig-v4-sign';
import { detectOperation, buildConditionFields } from './operations';
import { logS3Event } from './analytics';
import { s3XmlError, parseDeleteObjectKeys } from './xml';
import { getStub } from '../do-stub';
import type { HonoEnv } from '../types';
import type { RequestContext } from '../policy-types';

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

	// 2. Verify Sig V4 — supports both header-based and presigned URL auth
	const stub = getStub(c.env);
	const presigned = isPresignedUrl(url.searchParams);
	log.authMode = presigned ? 'presigned' : 'header';

	let accessKeyId: string;

	if (presigned) {
		// --- Presigned URL auth (X-Amz-* in query params) ---
		const parsed = parsePresignedParams(url.searchParams);
		if (!parsed) {
			log.status = 403;
			log.error = 'malformed_presigned';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return s3XmlError('AccessDenied', 'Malformed presigned URL parameters', 403);
		}

		accessKeyId = parsed.accessKeyId;
		log.accessKeyId = accessKeyId;

		const secret = await stub.getS3Secret(accessKeyId);
		if (!secret) {
			log.status = 403;
			log.error = 'invalid_access_key';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return s3XmlError('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', 403);
		}

		const verifyResult = await verifySigV4Presigned(c.req.raw, url, () => secret);
		if (!verifyResult.valid) {
			log.status = 403;
			log.error = verifyResult.error;
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));

			const errCode = verifyResult.error === 'SignatureDoesNotMatch' ? 'SignatureDoesNotMatch'
				: verifyResult.error === 'Request has expired' ? 'AccessDenied'
				: 'AccessDenied';
			const errMsg = verifyResult.error === 'SignatureDoesNotMatch'
				? 'The request signature we calculated does not match the signature you provided.'
				: (verifyResult.error || 'Access Denied');
			return s3XmlError(errCode, errMsg, 403);
		}
	} else {
		// --- Header-based auth (Authorization header) ---
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

		accessKeyId = parsed.accessKeyId;
		log.accessKeyId = accessKeyId;

		const secret = await stub.getS3Secret(accessKeyId);
		if (!secret) {
			log.status = 403;
			log.error = 'invalid_access_key';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return s3XmlError('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', 403);
		}

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

	// For DeleteObjects, parse the XML body and authorize each key individually
	let deleteObjectsBody: string | undefined;
	if (op.name === 'DeleteObjects' && op.bucket) {
		try {
			deleteObjectsBody = await c.req.text();
			const keys = parseDeleteObjectKeys(deleteObjectsBody);
			if (keys.length > 0) {
				// Replace the bucket-level context with per-key contexts
				contexts.length = 0;
				for (const key of keys) {
					// Build per-key condition fields with derived key.prefix / key.extension
					const keyFields: Record<string, string | boolean> = {
						...fields,
						key,
						bucket: op.bucket,
					};
					const lastSlash = key.lastIndexOf('/');
					if (lastSlash >= 0) {
						keyFields['key.prefix'] = key.slice(0, lastSlash + 1);
						keyFields['key.filename'] = key.slice(lastSlash + 1);
					} else {
						keyFields['key.prefix'] = '';
						keyFields['key.filename'] = key;
					}
					const dotIdx = key.lastIndexOf('.');
					if (dotIdx >= 0 && dotIdx > key.lastIndexOf('/')) {
						keyFields['key.extension'] = key.slice(dotIdx + 1);
					}

					contexts.push({
						action: 's3:DeleteObject',
						resource: `object:${op.bucket}/${key}`,
						fields: keyFields,
					});
				}
				log.deleteKeys = keys.length;
			}
		} catch {
			// If body parsing fails, fall through with bucket-level auth
		}
	}

	const authResult = await stub.authorizeS3(accessKeyId, contexts);
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
		const r2Response = await forwardToR2(c.req.raw, s3Path, c.env, deleteObjectsBody);

		log.status = r2Response.status;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));

		// Fire-and-forget analytics write
		if (c.env.ANALYTICS_DB) {
			c.executionCtx.waitUntil(
				logS3Event(c.env.ANALYTICS_DB, {
					credential_id: accessKeyId,
					operation: op.name,
					bucket: op.bucket || null,
					key: op.key || null,
					status: r2Response.status,
					duration_ms: Date.now() - start,
					created_at: Date.now(),
				}),
			);
		}

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

		// Log failed upstream requests too
		if (c.env.ANALYTICS_DB) {
			c.executionCtx.waitUntil(
				logS3Event(c.env.ANALYTICS_DB, {
					credential_id: accessKeyId,
					operation: op.name,
					bucket: op.bucket || null,
					key: op.key || null,
					status: 502,
					duration_ms: Date.now() - start,
					created_at: Date.now(),
				}),
			);
		}

		return s3XmlError('InternalError', 'An internal error occurred while contacting storage.', 502);
	}
});
