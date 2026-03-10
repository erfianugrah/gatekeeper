import { Hono } from 'hono';
import { verifySigV4, verifySigV4Presigned, parseAuthHeader, isPresignedUrl, parsePresignedParams } from './sig-v4-verify';
import { forwardToR2 } from './sig-v4-sign';
import { detectOperation, buildConditionFields, isR2Supported } from './operations';
import { logS3Event } from './analytics';
import type { S3Event } from './analytics';
import { s3XmlError, parseDeleteObjectKeys } from './xml';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { MAX_DELETE_OBJECTS_BODY_BYTES, MAX_LOG_VALUE_LENGTH, AUDIT_CREATED_BY_API_KEY } from '../constants';
import type { HonoEnv } from '../types';
import type { RequestContext } from '../policy-types';
import type { R2Credentials } from './upstream-r2';

// ─── S3 sub-app ─────────────────────────────────────────────────────────────

const VALID_S3_METHODS = new Set(['GET', 'HEAD', 'PUT', 'POST', 'DELETE']);

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

	// 1. Reject unsupported HTTP methods early
	if (!VALID_S3_METHODS.has(c.req.method)) {
		log.status = 405;
		log.error = 'method_not_allowed';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('MethodNotAllowed', `The specified method is not allowed: ${c.req.method}`, 405);
	}

	// 2. Detect the S3 operation
	const op = detectOperation(c.req.method, s3Path, url.searchParams, c.req.raw.headers);
	log.operation = op.name;
	log.bucket = op.bucket;
	log.key = op.key;

	// Reject operations not supported by R2 early — saves IAM eval and upstream round-trip
	if (!isR2Supported(op.name)) {
		log.status = 501;
		log.error = 'not_implemented';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('NotImplemented', `The operation ${op.name} is not supported.`, 501);
	}

	// 3. Verify Sig V4 — supports both header-based and presigned URL auth
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

			const errCode =
				verifyResult.error === 'SignatureDoesNotMatch'
					? 'SignatureDoesNotMatch'
					: verifyResult.error === 'Request has expired'
						? 'AccessDenied'
						: 'AccessDenied';
			const errMsg =
				verifyResult.error === 'SignatureDoesNotMatch'
					? 'The request signature we calculated does not match the signature you provided.'
					: verifyResult.error || 'Access Denied';
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
			const errMsg =
				verifyResult.error === 'SignatureDoesNotMatch'
					? 'The request signature we calculated does not match the signature you provided.'
					: verifyResult.error || 'Access Denied';
			return s3XmlError(errCode, errMsg, 403);
		}
	}

	// 3. Build request context and authorize via IAM
	const fields = buildConditionFields(op, c.req.method, c.req.raw.headers, url.searchParams);
	// Merge request-level fields (IP, geo, time) into condition fields
	const reqFields = extractRequestFields(c.req.raw);
	Object.assign(fields, reqFields);
	const contexts: RequestContext[] = [
		{
			action: op.action,
			resource: op.resource,
			fields,
		},
	];

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
			// AWS limits DeleteObjects to 1,000 keys; reject oversized bodies (>1 MB is generous)
			const contentLength = Number(c.req.header('content-length') ?? 0);
			if (contentLength > MAX_DELETE_OBJECTS_BODY_BYTES) {
				log.status = 400;
				log.error = 'body_too_large';
				log.durationMs = Date.now() - start;
				console.log(JSON.stringify(log));
				return s3XmlError('MaxMessageLengthExceeded', 'Your request body exceeds the maximum allowed size.', 400);
			}
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
			// Malformed XML — reject per AWS S3 API spec
			log.status = 400;
			log.error = 'malformed_xml';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return s3XmlError('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.', 400);
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

	// 3b. Account-level S3 rate limit check
	const rlResult = await stub.consumeS3RateLimit();
	if (!rlResult.allowed) {
		log.status = 429;
		log.error = 'rate_limited';
		log.retryAfterSec = rlResult.retryAfterSec;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('SlowDown', 'Please reduce your request rate.', 429, undefined, {
			'Retry-After': String(rlResult.retryAfterSec),
		});
	}

	// 4. Resolve upstream R2 credentials for this bucket
	//    Key-pinned upstream R2 endpoint takes priority over bucket-based resolution
	let r2Creds: R2Credentials | null;
	if (authResult.upstreamTokenId) {
		r2Creds = await stub.resolveR2ById(authResult.upstreamTokenId);
	} else if (op.bucket) {
		r2Creds = await stub.resolveR2ForBucket(op.bucket);
	} else {
		// ListBuckets or root-level operation
		r2Creds = await stub.resolveR2ForListBuckets();
	}

	if (!r2Creds) {
		const detail = authResult.upstreamTokenId
			? `Pinned upstream R2 endpoint ${authResult.upstreamTokenId} not found`
			: `No upstream R2 endpoint registered for bucket: ${op.bucket ?? '(none)'}`;
		log.status = 502;
		log.error = authResult.upstreamTokenId ? 'pinned_upstream_r2_not_found' : 'no_upstream_r2';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return s3XmlError('InternalError', detail, 502);
	}

	// 5. Forward to R2 — let R2 handle its own errors (501 NotImplemented, 404, etc.)
	try {
		const r2Response = await forwardToR2(c.req.raw, s3Path, r2Creds, deleteObjectsBody);

		log.status = r2Response.status;
		log.identity = accessKeyId;
		log.durationMs = Date.now() - start;

		// Capture R2 error response detail for debugging (status >= 400)
		let responseDetail: string | null = null;
		if (r2Response.status >= 400) {
			try {
				const errorBody = await r2Response.clone().text();
				responseDetail = errorBody.length > MAX_LOG_VALUE_LENGTH ? errorBody.slice(0, MAX_LOG_VALUE_LENGTH) : errorBody;
			} catch {
				// Body not readable — skip
			}
		}

		if (responseDetail) log.responseDetail = responseDetail;
		console.log(JSON.stringify(log));

		// Fire-and-forget analytics write
		if (c.env.ANALYTICS_DB) {
			const event = buildS3Event(
				accessKeyId,
				authResult.keyName,
				op.name,
				op.bucket,
				op.key,
				r2Response.status,
				Date.now() - start,
				responseDetail,
			);
			c.executionCtx.waitUntil(logS3Event(c.env.ANALYTICS_DB, event));
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
		log.identity = accessKeyId;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));

		// Log failed upstream requests too
		if (c.env.ANALYTICS_DB) {
			const event = buildS3Event(accessKeyId, authResult.keyName, op.name, op.bucket, op.key, 502, Date.now() - start, e.message ?? null);
			c.executionCtx.waitUntil(logS3Event(c.env.ANALYTICS_DB, event));
		}

		return s3XmlError('InternalError', 'An internal error occurred while contacting storage.', 502);
	}
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build an S3Event for D1 analytics. */
function buildS3Event(
	credentialId: string,
	credentialName: string | undefined,
	operation: string,
	bucket: string | undefined,
	key: string | undefined,
	status: number,
	durationMs: number,
	responseDetail: string | null,
): S3Event {
	return {
		credential_id: credentialId,
		operation,
		bucket: bucket || null,
		key: key || null,
		status,
		duration_ms: durationMs,
		response_detail: responseDetail,
		created_by: credentialName ? `credential:${credentialName}` : AUDIT_CREATED_BY_API_KEY,
		created_at: Date.now(),
	};
}
