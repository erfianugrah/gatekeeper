import type { S3Operation, S3OperationName, R2SupportedOperation } from './types';

// ─── Operation detection ────────────────────────────────────────────────────
// Maps HTTP method + path + query params to an S3 operation and IAM action.
// Path is relative to /s3/, so /s3/my-bucket/key.txt → ["my-bucket", "key.txt"].

/** Map S3 operation names to IAM action strings. */
const ACTION_MAP: Record<S3OperationName, string> = {
	// --- R2-supported operations ---
	ListBuckets: 's3:ListAllMyBuckets',
	HeadBucket: 's3:HeadBucket',
	CreateBucket: 's3:CreateBucket',
	DeleteBucket: 's3:DeleteBucket',
	GetBucketLocation: 's3:GetBucketLocation',
	GetBucketEncryption: 's3:GetEncryptionConfiguration',
	GetBucketCors: 's3:GetBucketCors',
	PutBucketCors: 's3:PutBucketCors',
	DeleteBucketCors: 's3:DeleteBucketCors',
	GetBucketLifecycle: 's3:GetLifecycleConfiguration',
	PutBucketLifecycle: 's3:PutLifecycleConfiguration',
	ListObjects: 's3:ListBucket',
	ListObjectsV2: 's3:ListBucket',
	ListMultipartUploads: 's3:ListBucketMultipartUploads',
	GetObject: 's3:GetObject',
	HeadObject: 's3:GetObject',
	PutObject: 's3:PutObject',
	CopyObject: 's3:PutObject',
	DeleteObject: 's3:DeleteObject',
	DeleteObjects: 's3:DeleteObject',
	CreateMultipartUpload: 's3:PutObject',
	UploadPart: 's3:PutObject',
	UploadPartCopy: 's3:PutObject',
	CompleteMultipartUpload: 's3:PutObject',
	AbortMultipartUpload: 's3:AbortMultipartUpload',
	ListParts: 's3:ListMultipartUploadParts',

	// --- R2-unsupported operations (still need IAM actions for policy completeness) ---
	GetObjectTagging: 's3:GetObjectTagging',
	PutObjectTagging: 's3:PutObjectTagging',
	DeleteObjectTagging: 's3:DeleteObjectTagging',
	GetBucketAcl: 's3:GetBucketAcl',
	PutBucketAcl: 's3:PutBucketAcl',
	GetBucketVersioning: 's3:GetBucketVersioning',
	PutBucketVersioning: 's3:PutBucketVersioning',
	GetBucketPolicy: 's3:GetBucketPolicy',
	PutBucketPolicy: 's3:PutBucketPolicy',
	DeleteBucketPolicy: 's3:DeleteBucketPolicy',
	GetBucketTagging: 's3:GetBucketTagging',
	PutBucketTagging: 's3:PutBucketTagging',
	DeleteBucketTagging: 's3:DeleteBucketTagging',
	GetBucketWebsite: 's3:GetBucketWebsite',
	PutBucketWebsite: 's3:PutBucketWebsite',
	DeleteBucketWebsite: 's3:DeleteBucketWebsite',
	GetBucketLogging: 's3:GetBucketLogging',
	PutBucketLogging: 's3:PutBucketLogging',
	GetBucketNotification: 's3:GetBucketNotificationConfiguration',
	PutBucketNotification: 's3:PutBucketNotificationConfiguration',
	GetBucketReplication: 's3:GetReplicationConfiguration',
	PutBucketReplication: 's3:PutReplicationConfiguration',
	DeleteBucketReplication: 's3:DeleteReplicationConfiguration',
	GetObjectLockConfiguration: 's3:GetObjectLockConfiguration',
	PutObjectLockConfiguration: 's3:PutObjectLockConfiguration',
	GetObjectRetention: 's3:GetObjectRetention',
	PutObjectRetention: 's3:PutObjectRetention',
	GetObjectLegalHold: 's3:GetObjectLegalHold',
	PutObjectLegalHold: 's3:PutObjectLegalHold',
	GetPublicAccessBlock: 's3:GetBucketPublicAccessBlock',
	PutPublicAccessBlock: 's3:PutBucketPublicAccessBlock',
	DeletePublicAccessBlock: 's3:DeleteBucketPublicAccessBlock',
	GetBucketAccelerateConfiguration: 's3:GetAccelerateConfiguration',
	PutBucketAccelerateConfiguration: 's3:PutAccelerateConfiguration',
	GetBucketRequestPayment: 's3:GetBucketRequestPayment',
	PutBucketRequestPayment: 's3:PutBucketRequestPayment',
	GetObjectAcl: 's3:GetObjectAcl',
	PutObjectAcl: 's3:PutObjectAcl',
	RestoreObject: 's3:RestoreObject',
	SelectObjectContent: 's3:SelectObjectContent',
};

/** Operations that R2 actually supports — only these get forwarded upstream. */
const R2_SUPPORTED: ReadonlySet<S3OperationName> = new Set<R2SupportedOperation>([
	'ListBuckets',
	'HeadBucket',
	'CreateBucket',
	'DeleteBucket',
	'GetBucketLocation',
	'GetBucketEncryption',
	'GetBucketCors',
	'PutBucketCors',
	'DeleteBucketCors',
	'GetBucketLifecycle',
	'PutBucketLifecycle',
	'ListObjects',
	'ListObjectsV2',
	'ListMultipartUploads',
	'GetObject',
	'HeadObject',
	'PutObject',
	'CopyObject',
	'DeleteObject',
	'DeleteObjects',
	'CreateMultipartUpload',
	'UploadPart',
	'UploadPartCopy',
	'CompleteMultipartUpload',
	'AbortMultipartUpload',
	'ListParts',
]);

/** Check if an operation is supported by R2 and should be forwarded upstream. */
export function isR2Supported(name: S3OperationName): boolean {
	return R2_SUPPORTED.has(name);
}

/**
 * Parse an S3 path (after stripping /s3/ prefix) into bucket and key.
 * Returns [bucket, key] where key may be undefined for bucket-level ops.
 */
export function parsePath(path: string): { bucket?: string; key?: string } {
	// Remove leading slash
	const trimmed = path.startsWith('/') ? path.slice(1) : path;
	if (!trimmed) return {};

	const slashIdx = trimmed.indexOf('/');
	if (slashIdx === -1) {
		return { bucket: decodeURIComponent(trimmed) };
	}

	return {
		bucket: decodeURIComponent(trimmed.slice(0, slashIdx)),
		key: decodeURIComponent(trimmed.slice(slashIdx + 1)),
	};
}

/**
 * Detect the S3 operation from an HTTP request.
 * The path should be the portion after /s3, e.g. "/my-bucket/key.txt".
 */
export function detectOperation(
	method: string,
	path: string,
	searchParams: URLSearchParams,
	headers: Headers,
): S3Operation {
	const { bucket, key } = parsePath(path);
	const hasKey = key !== undefined && key !== '';
	const hasUploadId = searchParams.has('uploadId');
	const hasCopySource = headers.has('x-amz-copy-source');

	let name: S3OperationName;

	if (!bucket) {
		// Root path — only ListBuckets
		name = 'ListBuckets';
		return buildOp(name, undefined, undefined);
	}

	if (hasKey) {
		// Object-level operations
		switch (method) {
			case 'GET':
				if (hasUploadId) name = 'ListParts';
				else if (searchParams.has('tagging')) name = 'GetObjectTagging';
				else if (searchParams.has('acl')) name = 'GetObjectAcl';
				else if (searchParams.has('retention')) name = 'GetObjectRetention';
				else if (searchParams.has('legal-hold')) name = 'GetObjectLegalHold';
				else if (searchParams.has('select') && searchParams.get('select-type') === '2') name = 'SelectObjectContent';
				else name = 'GetObject';
				break;
			case 'HEAD':
				name = 'HeadObject';
				break;
			case 'PUT':
				if (hasUploadId) {
					name = hasCopySource ? 'UploadPartCopy' : 'UploadPart';
				} else if (searchParams.has('tagging')) {
					name = 'PutObjectTagging';
				} else if (searchParams.has('acl')) {
					name = 'PutObjectAcl';
				} else if (searchParams.has('retention')) {
					name = 'PutObjectRetention';
				} else if (searchParams.has('legal-hold')) {
					name = 'PutObjectLegalHold';
				} else if (hasCopySource) {
					name = 'CopyObject';
				} else {
					name = 'PutObject';
				}
				break;
			case 'DELETE':
				if (hasUploadId) name = 'AbortMultipartUpload';
				else if (searchParams.has('tagging')) name = 'DeleteObjectTagging';
				else name = 'DeleteObject';
				break;
			case 'POST':
				if (searchParams.has('uploads')) name = 'CreateMultipartUpload';
				else if (hasUploadId) name = 'CompleteMultipartUpload';
				else if (searchParams.has('restore')) name = 'RestoreObject';
				else if (searchParams.has('select') && searchParams.get('select-type') === '2') name = 'SelectObjectContent';
				else name = 'PutObject'; // fallback
				break;
			default:
				name = 'GetObject'; // fallback
		}
		return buildOp(name, bucket, key);
	}

	// Bucket-level operations
	switch (method) {
		case 'GET':
			if (searchParams.has('cors')) name = 'GetBucketCors';
			else if (searchParams.has('lifecycle')) name = 'GetBucketLifecycle';
			else if (searchParams.has('location')) name = 'GetBucketLocation';
			else if (searchParams.has('encryption')) name = 'GetBucketEncryption';
			else if (searchParams.has('uploads')) name = 'ListMultipartUploads';
			else if (searchParams.has('acl')) name = 'GetBucketAcl';
			else if (searchParams.has('versioning')) name = 'GetBucketVersioning';
			else if (searchParams.has('policy')) name = 'GetBucketPolicy';
			else if (searchParams.has('tagging')) name = 'GetBucketTagging';
			else if (searchParams.has('website')) name = 'GetBucketWebsite';
			else if (searchParams.has('logging')) name = 'GetBucketLogging';
			else if (searchParams.has('notification')) name = 'GetBucketNotification';
			else if (searchParams.has('replication')) name = 'GetBucketReplication';
			else if (searchParams.has('object-lock')) name = 'GetObjectLockConfiguration';
			else if (searchParams.has('publicAccessBlock')) name = 'GetPublicAccessBlock';
			else if (searchParams.has('accelerate')) name = 'GetBucketAccelerateConfiguration';
			else if (searchParams.has('requestPayment')) name = 'GetBucketRequestPayment';
			else if (searchParams.get('list-type') === '2') name = 'ListObjectsV2';
			else name = 'ListObjects';
			break;
		case 'HEAD':
			name = 'HeadBucket';
			break;
		case 'PUT':
			if (searchParams.has('cors')) name = 'PutBucketCors';
			else if (searchParams.has('lifecycle')) name = 'PutBucketLifecycle';
			else if (searchParams.has('acl')) name = 'PutBucketAcl';
			else if (searchParams.has('versioning')) name = 'PutBucketVersioning';
			else if (searchParams.has('policy')) name = 'PutBucketPolicy';
			else if (searchParams.has('tagging')) name = 'PutBucketTagging';
			else if (searchParams.has('website')) name = 'PutBucketWebsite';
			else if (searchParams.has('logging')) name = 'PutBucketLogging';
			else if (searchParams.has('notification')) name = 'PutBucketNotification';
			else if (searchParams.has('replication')) name = 'PutBucketReplication';
			else if (searchParams.has('object-lock')) name = 'PutObjectLockConfiguration';
			else if (searchParams.has('publicAccessBlock')) name = 'PutPublicAccessBlock';
			else if (searchParams.has('accelerate')) name = 'PutBucketAccelerateConfiguration';
			else if (searchParams.has('requestPayment')) name = 'PutBucketRequestPayment';
			else name = 'CreateBucket';
			break;
		case 'DELETE':
			if (searchParams.has('cors')) name = 'DeleteBucketCors';
			else if (searchParams.has('policy')) name = 'DeleteBucketPolicy';
			else if (searchParams.has('tagging')) name = 'DeleteBucketTagging';
			else if (searchParams.has('website')) name = 'DeleteBucketWebsite';
			else if (searchParams.has('replication')) name = 'DeleteBucketReplication';
			else if (searchParams.has('publicAccessBlock')) name = 'DeletePublicAccessBlock';
			else name = 'DeleteBucket';
			break;
		case 'POST':
			if (searchParams.has('delete')) name = 'DeleteObjects';
			else name = 'ListObjects'; // fallback
			break;
		default:
			name = 'ListObjects'; // fallback
	}

	return buildOp(name, bucket, undefined);
}

/** Build an S3Operation with the correct resource string. */
function buildOp(name: S3OperationName, bucket: string | undefined, key: string | undefined): S3Operation {
	const action = ACTION_MAP[name];
	let resource: string;

	if (!bucket) {
		resource = 'account:*';
	} else if (key !== undefined && key !== '') {
		resource = `object:${bucket}/${key}`;
	} else {
		resource = `bucket:${bucket}`;
	}

	return { name, action, resource, bucket, key };
}

/**
 * Build condition fields from the S3 request for policy evaluation.
 */
export function buildConditionFields(
	op: S3Operation,
	method: string,
	headers: Headers,
	searchParams: URLSearchParams,
): Record<string, string | boolean> {
	const fields: Record<string, string | boolean> = {
		method,
	};

	if (op.bucket) {
		fields.bucket = op.bucket;
	}

	if (op.key) {
		fields.key = op.key;

		// Derived key fields
		const lastSlash = op.key.lastIndexOf('/');
		if (lastSlash >= 0) {
			fields['key.prefix'] = op.key.slice(0, lastSlash + 1);
			fields['key.filename'] = op.key.slice(lastSlash + 1);
		} else {
			fields['key.prefix'] = '';
			fields['key.filename'] = op.key;
		}

		const dotIdx = op.key.lastIndexOf('.');
		if (dotIdx >= 0 && dotIdx > op.key.lastIndexOf('/')) {
			fields['key.extension'] = op.key.slice(dotIdx + 1);
		}
	}

	// Content headers (relevant for PutObject)
	const contentType = headers.get('content-type');
	if (contentType) fields.content_type = contentType;

	const contentLength = headers.get('content-length');
	if (contentLength) fields.content_length = contentLength;

	// Copy source (for CopyObject)
	const copySource = headers.get('x-amz-copy-source');
	if (copySource) {
		const decoded = decodeURIComponent(copySource);
		const trimmed = decoded.startsWith('/') ? decoded.slice(1) : decoded;
		const slashIdx = trimmed.indexOf('/');
		if (slashIdx >= 0) {
			fields.source_bucket = trimmed.slice(0, slashIdx);
			fields.source_key = trimmed.slice(slashIdx + 1);
		} else {
			fields.source_bucket = trimmed;
		}
	}

	// List prefix
	const listPrefix = searchParams.get('prefix');
	if (listPrefix !== null) {
		fields.list_prefix = listPrefix;
	}

	return fields;
}
