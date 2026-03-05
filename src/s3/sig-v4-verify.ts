import type { SigV4Components, SigV4VerifyResult } from './types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Accepted regions — R2 uses "auto", but clients may send "us-east-1" or empty string. */
const VALID_REGIONS = new Set(['auto', 'us-east-1', '']);

/** Maximum allowed clock skew for Sig V4 timestamps (15 minutes, per AWS spec). */
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

const ENCODER = new TextEncoder();

// ─── Public API ─────────────────────────────────────────────────────────────

/** Check if a request uses presigned URL authentication (Sig V4 in query params). */
export function isPresignedUrl(searchParams: URLSearchParams): boolean {
	return searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256';
}

/**
 * Verify an inbound AWS Sig V4 signed request (header-based auth).
 * Returns the access_key_id if valid, or an error message.
 *
 * @param request - The incoming HTTP request
 * @param url - Parsed URL of the request
 * @param getSecret - Function to look up the secret_access_key for a given access_key_id
 */
export async function verifySigV4(
	request: Request,
	url: URL,
	getSecret: (accessKeyId: string) => string | null,
): Promise<SigV4VerifyResult> {
	// 1. Parse Authorization header
	const authHeader = request.headers.get('authorization');
	if (!authHeader) {
		return { valid: false, error: 'Missing Authorization header' };
	}

	const parsed = parseAuthHeader(authHeader);
	if (!parsed) {
		return { valid: false, error: 'Malformed Authorization header' };
	}

	// 2. Validate region
	if (!VALID_REGIONS.has(parsed.region)) {
		return { valid: false, error: `Invalid region: ${parsed.region}` };
	}

	// 3. Validate timestamp (x-amz-date header)
	const amzDate = request.headers.get('x-amz-date');
	if (!amzDate) {
		return { valid: false, error: 'Missing x-amz-date header' };
	}

	const requestTime = parseAmzDate(amzDate);
	if (!requestTime) {
		return { valid: false, error: 'Invalid x-amz-date format' };
	}

	const now = Date.now();
	if (Math.abs(now - requestTime) > MAX_CLOCK_SKEW_MS) {
		return { valid: false, error: 'Request timestamp is too far from current time' };
	}

	// 4. Look up secret
	const secret = getSecret(parsed.accessKeyId);
	if (secret === null) {
		return { valid: false, accessKeyId: parsed.accessKeyId, error: 'InvalidAccessKeyId' };
	}

	// 5. Build canonical request
	const contentHash = request.headers.get('x-amz-content-sha256') || 'UNSIGNED-PAYLOAD';
	const canonicalRequest = buildCanonicalRequest(
		request.method,
		url.pathname,
		url.searchParams,
		request.headers,
		parsed.signedHeaders,
		contentHash,
		url,
		false,
		request,
	);

	// 6. Build string to sign
	const canonicalRequestHash = await sha256Hex(canonicalRequest);
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		parsed.credentialScope,
		canonicalRequestHash,
	].join('\n');

	// 7. Derive signing key
	const signingKey = await deriveSigningKey(secret, parsed.date, parsed.region, parsed.service);

	// 8. Compute expected signature
	const expectedSig = await hmacHex(signingKey, stringToSign);

	// 9. Constant-time comparison
	const isValid = await timingSafeCompare(parsed.signature, expectedSig);

	if (!isValid) {
		return { valid: false, accessKeyId: parsed.accessKeyId, error: 'SignatureDoesNotMatch' };
	}

	return { valid: true, accessKeyId: parsed.accessKeyId };
}

/**
 * Verify an inbound AWS Sig V4 presigned URL (query string auth).
 *
 * Presigned URLs carry auth parameters in query strings:
 *   X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date, X-Amz-Expires,
 *   X-Amz-SignedHeaders, X-Amz-Signature
 *
 * The canonical request differs from header-based auth:
 * - Canonical query string includes all X-Amz-* params EXCEPT X-Amz-Signature
 * - Payload hash is always UNSIGNED-PAYLOAD for S3
 * - Signed headers typically only contain "host"
 */
export async function verifySigV4Presigned(
	request: Request,
	url: URL,
	getSecret: (accessKeyId: string) => string | null,
): Promise<SigV4VerifyResult> {
	// 1. Parse presigned URL parameters
	const parsed = parsePresignedParams(url.searchParams);
	if (!parsed) {
		return { valid: false, error: 'Malformed presigned URL parameters' };
	}

	// 2. Validate region
	if (!VALID_REGIONS.has(parsed.region)) {
		return { valid: false, error: `Invalid region: ${parsed.region}` };
	}

	// 3. Validate timestamp and expiry
	const amzDate = url.searchParams.get('X-Amz-Date');
	if (!amzDate) {
		return { valid: false, error: 'Missing X-Amz-Date parameter' };
	}

	const requestTime = parseAmzDate(amzDate);
	if (!requestTime) {
		return { valid: false, error: 'Invalid X-Amz-Date format' };
	}

	const expiresStr = url.searchParams.get('X-Amz-Expires');
	if (!expiresStr) {
		return { valid: false, error: 'Missing X-Amz-Expires parameter' };
	}

	const expiresSec = Number(expiresStr);
	if (!Number.isFinite(expiresSec) || expiresSec <= 0) {
		return { valid: false, error: 'Invalid X-Amz-Expires value' };
	}

	// AWS max is 7 days (604800 seconds)
	if (expiresSec > 604800) {
		return { valid: false, error: 'X-Amz-Expires exceeds maximum (604800 seconds)' };
	}

	const now = Date.now();
	const expiryTime = requestTime + expiresSec * 1000;
	if (now > expiryTime) {
		return { valid: false, error: 'Request has expired' };
	}

	// Also check that the request wasn't signed too far in the future
	if (requestTime > now + MAX_CLOCK_SKEW_MS) {
		return { valid: false, error: 'Request timestamp is too far in the future' };
	}

	// 4. Look up secret
	const secret = getSecret(parsed.accessKeyId);
	if (secret === null) {
		return { valid: false, accessKeyId: parsed.accessKeyId, error: 'InvalidAccessKeyId' };
	}

	// 5. Build canonical request — exclude X-Amz-Signature from query string
	const canonicalRequest = buildCanonicalRequest(
		request.method,
		url.pathname,
		url.searchParams,
		request.headers,
		parsed.signedHeaders,
		'UNSIGNED-PAYLOAD',
		url,
		true, // excludeSignature — omit X-Amz-Signature from canonical query string
		request,
	);

	// 6. Build string to sign
	const canonicalRequestHash = await sha256Hex(canonicalRequest);
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		parsed.credentialScope,
		canonicalRequestHash,
	].join('\n');

	// 7. Derive signing key
	const signingKey = await deriveSigningKey(secret, parsed.date, parsed.region, parsed.service);

	// 8. Compute expected signature
	const expectedSig = await hmacHex(signingKey, stringToSign);

	// 9. Constant-time comparison
	const isValid = await timingSafeCompare(parsed.signature, expectedSig);

	if (!isValid) {
		return { valid: false, accessKeyId: parsed.accessKeyId, error: 'SignatureDoesNotMatch' };
	}

	return { valid: true, accessKeyId: parsed.accessKeyId };
}

// ─── Authorization header parsing ───────────────────────────────────────────

/**
 * Parse the AWS Sig V4 Authorization header.
 *
 * Format:
 * AWS4-HMAC-SHA256 Credential={key}/{date}/{region}/s3/aws4_request,
 *   SignedHeaders={headers},
 *   Signature={sig}
 */
export function parseAuthHeader(header: string): SigV4Components | null {
	if (!header.startsWith('AWS4-HMAC-SHA256 ')) return null;

	const rest = header.slice('AWS4-HMAC-SHA256 '.length);

	const credMatch = rest.match(/Credential=([^,]+)/);
	const headersMatch = rest.match(/SignedHeaders=([^,]+)/);
	const sigMatch = rest.match(/Signature=([0-9a-f]+)/);

	if (!credMatch || !headersMatch || !sigMatch) return null;

	const credParts = credMatch[1].split('/');
	if (credParts.length !== 5) return null;

	const [accessKeyId, date, region, service, requestType] = credParts;
	if (requestType !== 'aws4_request') return null;

	return {
		accessKeyId,
		date,
		region,
		service,
		signedHeaders: headersMatch[1].split(';'),
		signature: sigMatch[1],
		credentialScope: `${date}/${region}/${service}/aws4_request`,
	};
}

// ─── Presigned URL parameter parsing ────────────────────────────────────────

/**
 * Parse Sig V4 components from presigned URL query parameters.
 *
 * Expected params:
 *   X-Amz-Algorithm=AWS4-HMAC-SHA256
 *   X-Amz-Credential={accessKeyId}/{date}/{region}/s3/aws4_request
 *   X-Amz-SignedHeaders={headers}
 *   X-Amz-Signature={sig}
 */
export function parsePresignedParams(searchParams: URLSearchParams): SigV4Components | null {
	const algorithm = searchParams.get('X-Amz-Algorithm');
	if (algorithm !== 'AWS4-HMAC-SHA256') return null;

	const credential = searchParams.get('X-Amz-Credential');
	const signedHeaders = searchParams.get('X-Amz-SignedHeaders');
	const signature = searchParams.get('X-Amz-Signature');

	if (!credential || !signedHeaders || !signature) return null;

	const credParts = credential.split('/');
	if (credParts.length !== 5) return null;

	const [accessKeyId, date, region, service, requestType] = credParts;
	if (requestType !== 'aws4_request') return null;

	return {
		accessKeyId,
		date,
		region,
		service,
		signedHeaders: signedHeaders.split(';'),
		signature,
		credentialScope: `${date}/${region}/${service}/aws4_request`,
	};
}

// ─── Canonical request ──────────────────────────────────────────────────────

function buildCanonicalRequest(
	method: string,
	path: string,
	searchParams: URLSearchParams,
	headers: Headers,
	signedHeaders: string[],
	contentHash: string,
	url: URL,
	excludeSignature = false,
	request?: Request,
): string {
	const canonicalUri = encodeCanonicalPath(path);
	const canonicalQueryString = buildCanonicalQueryString(searchParams, excludeSignature);
	const canonicalHeaders = buildCanonicalHeaders(headers, signedHeaders, url, request);
	const signedHeadersStr = signedHeaders.join(';');

	return [
		method,
		canonicalUri,
		canonicalQueryString,
		canonicalHeaders,
		'',
		signedHeadersStr,
		contentHash,
	].join('\n');
}

/**
 * URI-encode the path component per AWS Sig V4 rules for S3.
 *
 * Must match aws4fetch's algorithm exactly:
 * 1. Decode the path fully (handles already-percent-encoded segments like %20)
 * 2. Re-encode with encodeURIComponent, then restore slashes
 * 3. Encode RFC 3986 extra characters (! ' ( ) *) that encodeURIComponent misses
 */
function encodeCanonicalPath(path: string): string {
	if (path === '/' || !path) return '/';

	// Step 1: Fully decode — normalizes any existing percent-encoding
	let decoded: string;
	try {
		decoded = decodeURIComponent(path.replace(/\+/g, ' '));
	} catch {
		// Malformed percent sequences — use as-is
		decoded = path;
	}

	// Step 2: Re-encode everything, then restore forward slashes
	const encoded = encodeURIComponent(decoded).replace(/%2F/g, '/');

	// Step 3: Encode RFC 3986 characters not covered by encodeURIComponent
	return encoded.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build the canonical query string — sorted by key, then value.
 * When excludeSignature is true, X-Amz-Signature is omitted (for presigned URL verification).
 */
function buildCanonicalQueryString(searchParams: URLSearchParams, excludeSignature = false): string {
	const pairs: [string, string][] = [];
	searchParams.forEach((value, key) => {
		if (excludeSignature && key === 'X-Amz-Signature') return;
		pairs.push([encodeURIComponent(key), encodeURIComponent(value)]);
	});
	pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
	return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Build canonical headers — lowercase, trimmed, newline-terminated.
 *
 * Special handling for `accept-encoding`: Cloudflare's edge rewrites this
 * header (e.g. "identity" → "gzip, br"), which breaks Sig V4 verification.
 * We use `request.cf.clientAcceptEncoding` to recover the original value.
 */
function buildCanonicalHeaders(headers: Headers, signedHeaders: string[], url: URL, request?: Request): string {
	// Recover original accept-encoding from Cloudflare's request metadata
	const originalAcceptEncoding = (request?.cf as Record<string, unknown> | undefined)?.clientAcceptEncoding as string | undefined;

	return signedHeaders
		.map((name) => {
			let value = headers.get(name) || '';
			if (name === 'host' && !value) {
				value = url.host;
			}
			if (name === 'accept-encoding' && originalAcceptEncoding) {
				value = originalAcceptEncoding;
			}
			return `${name}:${value.trim().replace(/\s+/g, ' ')}`;
		})
		.join('\n');
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

/** Derive the Sig V4 signing key: HMAC chain of date/region/service/aws4_request. */
async function deriveSigningKey(
	secret: string,
	date: string,
	region: string,
	service: string,
): Promise<ArrayBuffer> {
	let key: ArrayBuffer = ENCODER.encode(`AWS4${secret}`).buffer as ArrayBuffer;
	key = await hmacRaw(key, date);
	key = await hmacRaw(key, region);
	key = await hmacRaw(key, service);
	key = await hmacRaw(key, 'aws4_request');
	return key;
}

/** HMAC-SHA256 returning raw bytes. */
async function hmacRaw(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return crypto.subtle.sign('HMAC', cryptoKey, ENCODER.encode(data));
}

/** HMAC-SHA256 returning hex string. */
async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
	const raw = await hmacRaw(key, data);
	return bufToHex(raw);
}

/** SHA-256 hex digest of a string. */
async function sha256Hex(data: string): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', ENCODER.encode(data));
	return bufToHex(hash);
}

/** Convert ArrayBuffer to lowercase hex string. */
function bufToHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** Constant-time hex string comparison using HMAC. */
async function timingSafeCompare(a: string, b: string): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		'raw',
		ENCODER.encode('sig-v4-compare'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const [macA, macB] = await Promise.all([
		crypto.subtle.sign('HMAC', key, ENCODER.encode(a)),
		crypto.subtle.sign('HMAC', key, ENCODER.encode(b)),
	]);
	// @ts-expect-error — timingSafeEqual exists in Workers runtime but not in all TS lib types
	return crypto.subtle.timingSafeEqual(macA, macB);
}

/** Parse ISO 8601 basic format: 20260305T111200Z → milliseconds. */
function parseAmzDate(dateStr: string): number | null {
	const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
	if (!match) return null;
	const [, y, m, d, h, min, s] = match;
	return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s));
}
