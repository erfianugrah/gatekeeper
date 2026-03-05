import { AwsClient } from 'aws4fetch';

// ─── Outbound re-signing ────────────────────────────────────────────────────
// Uses aws4fetch to re-sign requests with the R2 admin credentials.

/** Lazily-initialized AwsClient instance keyed by endpoint (one per worker lifetime). */
let cachedClient: AwsClient | null = null;
let cachedEndpoint = '';

/** Get or create the AwsClient for outbound R2 requests. */
function getClient(env: Env): AwsClient {
	if (cachedClient && cachedEndpoint === env.R2_ENDPOINT) {
		return cachedClient;
	}
	cachedClient = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
	cachedEndpoint = env.R2_ENDPOINT;
	return cachedClient;
}

/**
 * Query params to strip from the inbound request before forwarding to R2.
 * These are presigned URL authentication params — we re-sign with our own R2 credentials.
 */
const STRIP_QUERY_PARAMS = new Set([
	'X-Amz-Algorithm',
	'X-Amz-Credential',
	'X-Amz-Date',
	'X-Amz-Expires',
	'X-Amz-SignedHeaders',
	'X-Amz-Signature',
	'X-Amz-Security-Token',
	// SDK internal param — not needed by R2
	'x-id',
]);

/**
 * Headers to strip from the inbound request before forwarding to R2.
 * These are either hop-by-hop, Cloudflare-specific, or would conflict with re-signing.
 */
const STRIP_HEADERS = new Set([
	'authorization',
	'x-amz-date',
	'x-amz-content-sha256',
	'x-amz-security-token',
	'host',
	'cf-connecting-ip',
	'cf-ray',
	'cf-visitor',
	'cf-worker',
	'cf-ipcountry',
	'cf-access-jwt-assertion',
	'cf-access-authenticated-user-email',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'x-forwarded-proto',
	'x-real-ip',
	// SDK-specific headers that R2 doesn't understand
	'amz-sdk-invocation-id',
	'amz-sdk-request',
]);

/**
 * Re-sign a request for R2 and forward it.
 *
 * - Strips the /s3 prefix from the path
 * - Copies safe headers from the inbound request
 * - Streams the body without buffering (unless bodyOverride is provided)
 * - Returns the R2 response
 *
 * @param bodyOverride - If provided, used instead of request.body (for cases where
 *   the body was already consumed, e.g. DeleteObjects XML parsing).
 */
export async function forwardToR2(
	request: Request,
	s3Path: string,
	env: Env,
	bodyOverride?: string,
): Promise<Response> {
	const client = getClient(env);

	// Build the R2 URL: endpoint + path (without /s3 prefix)
	const r2Url = new URL(s3Path, env.R2_ENDPOINT);

	// Copy query params from original request — strip presigned URL auth params
	const inboundUrl = new URL(request.url);
	inboundUrl.searchParams.forEach((value, key) => {
		if (!STRIP_QUERY_PARAMS.has(key)) {
			r2Url.searchParams.set(key, value);
		}
	});

	// Copy safe headers
	const forwardHeaders = new Headers();
	request.headers.forEach((value, name) => {
		if (!STRIP_HEADERS.has(name.toLowerCase())) {
			forwardHeaders.set(name, value);
		}
	});

	// Use UNSIGNED-PAYLOAD for streaming — R2 supports it
	forwardHeaders.set('x-amz-content-sha256', 'UNSIGNED-PAYLOAD');

	// Determine body — use override if provided, otherwise stream from request
	let body: ReadableStream | string | undefined;
	if (bodyOverride !== undefined) {
		body = bodyOverride;
	} else {
		const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'DELETE';
		body = hasBody ? request.body ?? undefined : undefined;
	}

	// Sign and send
	const signed = await client.sign(r2Url.toString(), {
		method: request.method,
		headers: forwardHeaders,
		body,
	});

	return fetch(signed);
}
