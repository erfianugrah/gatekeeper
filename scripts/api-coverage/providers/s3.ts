/**
 * Coverage provider: S3 / R2 gateway.
 *
 * Not spec-backed — the S3 surface is a closed enum (`S3OperationName`) and the IAM action map
 * is compile-time-total (`Record<S3OperationName, string>`). So the authoritative op set comes
 * from the runtime-exported `S3_OPERATIONS`, and coverage is exercised through the proxy's real
 * `detectOperation` routing: each op carries a representative request, and `isCovered` asserts
 * detection routes it back to the same operation with a non-empty IAM action.
 *
 * Drift this catches: (a) an operation added to the enum/action map without a detection example
 * (the completeness guard in `fetchLiveOps` throws), and (b) a detection-routing regression that
 * makes a declared operation undetectable. There is no live AWS spec to fetch, so the snapshot
 * documents the supported operation surface and the test locks detection to it.
 */

import { detectOperation, S3_OPERATIONS } from '../../../src/s3/operations';
import type { S3OperationName } from '../../../src/s3/types';
import { opKey, type ApiOp, type CoverageProvider, type SnapshotOp } from '../types';
import snapshot from '../fixtures/s3.ops.json';

/** A representative request that detection must route to `name`. Query/headers are the discriminators. */
interface OpProbe {
	name: S3OperationName;
	method: string;
	/** S3 path relative to `/s3/`, e.g. `/bucket/key.txt`. */
	path: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
}

const BUCKET = '/bucket';
const OBJECT = '/bucket/key.txt';
const MPU = '/bucket/key'; // multipart object key

// One probe per S3OperationName. Mirrors the request shapes proven in test/s3-operations.test.ts.
const PROBES: OpProbe[] = [
	// --- R2-supported ---
	{ name: 'ListBuckets', method: 'GET', path: '/' },
	{ name: 'HeadBucket', method: 'HEAD', path: BUCKET },
	{ name: 'CreateBucket', method: 'PUT', path: BUCKET },
	{ name: 'DeleteBucket', method: 'DELETE', path: BUCKET },
	{ name: 'GetBucketLocation', method: 'GET', path: BUCKET, query: { location: '' } },
	{ name: 'GetBucketEncryption', method: 'GET', path: BUCKET, query: { encryption: '' } },
	{ name: 'GetBucketCors', method: 'GET', path: BUCKET, query: { cors: '' } },
	{ name: 'PutBucketCors', method: 'PUT', path: BUCKET, query: { cors: '' } },
	{ name: 'DeleteBucketCors', method: 'DELETE', path: BUCKET, query: { cors: '' } },
	{ name: 'GetBucketLifecycle', method: 'GET', path: BUCKET, query: { lifecycle: '' } },
	{ name: 'PutBucketLifecycle', method: 'PUT', path: BUCKET, query: { lifecycle: '' } },
	{ name: 'ListObjects', method: 'GET', path: BUCKET },
	{ name: 'ListObjectsV2', method: 'GET', path: BUCKET, query: { 'list-type': '2' } },
	{ name: 'ListMultipartUploads', method: 'GET', path: BUCKET, query: { uploads: '' } },
	{ name: 'GetObject', method: 'GET', path: OBJECT },
	{ name: 'HeadObject', method: 'HEAD', path: OBJECT },
	{ name: 'PutObject', method: 'PUT', path: OBJECT },
	{ name: 'CopyObject', method: 'PUT', path: OBJECT, headers: { 'x-amz-copy-source': '/src/k' } },
	{ name: 'DeleteObject', method: 'DELETE', path: OBJECT },
	{ name: 'DeleteObjects', method: 'POST', path: BUCKET, query: { delete: '' } },
	{ name: 'CreateMultipartUpload', method: 'POST', path: MPU, query: { uploads: '' } },
	{ name: 'UploadPart', method: 'PUT', path: MPU, query: { uploadId: '123' } },
	{ name: 'UploadPartCopy', method: 'PUT', path: MPU, query: { uploadId: '123' }, headers: { 'x-amz-copy-source': '/src/k' } },
	{ name: 'CompleteMultipartUpload', method: 'POST', path: MPU, query: { uploadId: '123' } },
	{ name: 'AbortMultipartUpload', method: 'DELETE', path: MPU, query: { uploadId: '123' } },
	{ name: 'ListParts', method: 'GET', path: MPU, query: { uploadId: '123' } },

	// --- R2-unsupported (detected for IAM completeness; forwarded then 501 from R2) ---
	{ name: 'GetObjectTagging', method: 'GET', path: OBJECT, query: { tagging: '' } },
	{ name: 'PutObjectTagging', method: 'PUT', path: OBJECT, query: { tagging: '' } },
	{ name: 'DeleteObjectTagging', method: 'DELETE', path: OBJECT, query: { tagging: '' } },
	{ name: 'GetBucketAcl', method: 'GET', path: BUCKET, query: { acl: '' } },
	{ name: 'PutBucketAcl', method: 'PUT', path: BUCKET, query: { acl: '' } },
	{ name: 'GetBucketVersioning', method: 'GET', path: BUCKET, query: { versioning: '' } },
	{ name: 'PutBucketVersioning', method: 'PUT', path: BUCKET, query: { versioning: '' } },
	{ name: 'GetBucketPolicy', method: 'GET', path: BUCKET, query: { policy: '' } },
	{ name: 'PutBucketPolicy', method: 'PUT', path: BUCKET, query: { policy: '' } },
	{ name: 'DeleteBucketPolicy', method: 'DELETE', path: BUCKET, query: { policy: '' } },
	{ name: 'GetBucketTagging', method: 'GET', path: BUCKET, query: { tagging: '' } },
	{ name: 'PutBucketTagging', method: 'PUT', path: BUCKET, query: { tagging: '' } },
	{ name: 'DeleteBucketTagging', method: 'DELETE', path: BUCKET, query: { tagging: '' } },
	{ name: 'GetBucketWebsite', method: 'GET', path: BUCKET, query: { website: '' } },
	{ name: 'PutBucketWebsite', method: 'PUT', path: BUCKET, query: { website: '' } },
	{ name: 'DeleteBucketWebsite', method: 'DELETE', path: BUCKET, query: { website: '' } },
	{ name: 'GetBucketLogging', method: 'GET', path: BUCKET, query: { logging: '' } },
	{ name: 'PutBucketLogging', method: 'PUT', path: BUCKET, query: { logging: '' } },
	{ name: 'GetBucketNotification', method: 'GET', path: BUCKET, query: { notification: '' } },
	{ name: 'PutBucketNotification', method: 'PUT', path: BUCKET, query: { notification: '' } },
	{ name: 'GetBucketReplication', method: 'GET', path: BUCKET, query: { replication: '' } },
	{ name: 'PutBucketReplication', method: 'PUT', path: BUCKET, query: { replication: '' } },
	{ name: 'DeleteBucketReplication', method: 'DELETE', path: BUCKET, query: { replication: '' } },
	{ name: 'GetObjectLockConfiguration', method: 'GET', path: BUCKET, query: { 'object-lock': '' } },
	{ name: 'PutObjectLockConfiguration', method: 'PUT', path: BUCKET, query: { 'object-lock': '' } },
	{ name: 'GetObjectRetention', method: 'GET', path: OBJECT, query: { retention: '' } },
	{ name: 'PutObjectRetention', method: 'PUT', path: OBJECT, query: { retention: '' } },
	{ name: 'GetObjectLegalHold', method: 'GET', path: OBJECT, query: { 'legal-hold': '' } },
	{ name: 'PutObjectLegalHold', method: 'PUT', path: OBJECT, query: { 'legal-hold': '' } },
	{ name: 'GetPublicAccessBlock', method: 'GET', path: BUCKET, query: { publicAccessBlock: '' } },
	{ name: 'PutPublicAccessBlock', method: 'PUT', path: BUCKET, query: { publicAccessBlock: '' } },
	{ name: 'DeletePublicAccessBlock', method: 'DELETE', path: BUCKET, query: { publicAccessBlock: '' } },
	{ name: 'GetBucketAccelerateConfiguration', method: 'GET', path: BUCKET, query: { accelerate: '' } },
	{ name: 'PutBucketAccelerateConfiguration', method: 'PUT', path: BUCKET, query: { accelerate: '' } },
	{ name: 'GetBucketRequestPayment', method: 'GET', path: BUCKET, query: { requestPayment: '' } },
	{ name: 'PutBucketRequestPayment', method: 'PUT', path: BUCKET, query: { requestPayment: '' } },
	{ name: 'GetObjectAcl', method: 'GET', path: OBJECT, query: { acl: '' } },
	{ name: 'PutObjectAcl', method: 'PUT', path: OBJECT, query: { acl: '' } },
	{ name: 'RestoreObject', method: 'POST', path: OBJECT, query: { restore: '' } },
	{ name: 'SelectObjectContent', method: 'POST', path: OBJECT, query: { select: '', 'select-type': '2' } },
];

const PROBE_BY_KEY = new Map<string, OpProbe>(PROBES.map((p) => [`${p.method.toUpperCase()} ${p.name}`, p]));

/** Run a probe through the real detection routing. Covered = routes back to the same op with an action. */
function detects(probe: OpProbe): boolean {
	const op = detectOperation(probe.method, probe.path, new URLSearchParams(probe.query ?? {}), new Headers(probe.headers ?? {}));
	return op.name === probe.name && op.action.length > 0;
}

export const s3Provider: CoverageProvider = {
	id: 's3',
	label: 'S3 / R2 gateway',
	snapshotPath: 'scripts/api-coverage/fixtures/s3.ops.json',
	snapshot: snapshot as SnapshotOp[],

	async fetchLiveOps(): Promise<ApiOp[]> {
		// Completeness guard: the enum is the source of truth — every declared op needs a probe.
		const probed = new Set(PROBES.map((p) => p.name));
		const missing = S3_OPERATIONS.filter((n) => !probed.has(n));
		if (missing.length) throw new Error(`s3: missing detection probes for ${missing.join(', ')} — add to PROBES in providers/s3.ts`);
		const extra = PROBES.filter((p) => !S3_OPERATIONS.includes(p.name)).map((p) => p.name);
		if (extra.length) throw new Error(`s3: probes for unknown ops ${extra.join(', ')} — remove from PROBES or update the enum`);

		// `path` is the operation name (this is a non-REST enum API); method + name keys uniquely.
		return PROBES.map((p) => ({
			method: p.method,
			path: p.name,
			summary: `${p.method} ${p.path}${p.query ? `?${new URLSearchParams(p.query)}` : ''}`,
		}));
	},

	isCovered(op: ApiOp): boolean {
		const probe = PROBE_BY_KEY.get(`${op.method.toUpperCase()} ${op.path}`);
		return probe ? detects(probe) : false;
	},

	// S3 has no intentional gaps — every declared operation is detected. Kept empty on purpose.
	allowlist: {},
};

export { opKey };
