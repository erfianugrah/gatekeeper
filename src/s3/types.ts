import type { PolicyDocument } from '../policy-types';

// ─── S3 Credentials ─────────────────────────────────────────────────────────

/** Stored S3 credential row from DO SQLite. */
export interface S3Credential {
	access_key_id: string;
	secret_access_key: string;
	name: string;
	created_at: number;
	expires_at: number | null;
	revoked: number;
	/** JSON-serialized PolicyDocument. */
	policy: string;
	/** Email of the user who created this credential (from Access JWT). */
	created_by: string | null;
}

/** Request body for creating an S3 credential. */
export interface CreateS3CredentialRequest {
	name: string;
	policy: PolicyDocument;
	expires_in_days?: number;
	created_by?: string;
}

/** Cached credential for the hot auth path. */
export interface CachedS3Credential {
	credential: S3Credential;
	resolvedPolicy: PolicyDocument;
	cachedAt: number;
}

// ─── S3 Operations ──────────────────────────────────────────────────────────

/** S3 operations supported by R2 — detect, authorize, and forward. */
export type R2SupportedOperation =
	| 'ListBuckets'
	| 'HeadBucket'
	| 'CreateBucket'
	| 'DeleteBucket'
	| 'GetBucketLocation'
	| 'GetBucketEncryption'
	| 'GetBucketCors'
	| 'PutBucketCors'
	| 'DeleteBucketCors'
	| 'GetBucketLifecycle'
	| 'PutBucketLifecycle'
	| 'ListObjects'
	| 'ListObjectsV2'
	| 'ListMultipartUploads'
	| 'GetObject'
	| 'HeadObject'
	| 'PutObject'
	| 'CopyObject'
	| 'DeleteObject'
	| 'DeleteObjects'
	| 'CreateMultipartUpload'
	| 'UploadPart'
	| 'UploadPartCopy'
	| 'CompleteMultipartUpload'
	| 'AbortMultipartUpload'
	| 'ListParts';

/** S3 operations NOT supported by R2 — detect and return NotImplemented (501). */
export type R2UnsupportedOperation =
	| 'GetObjectTagging'
	| 'PutObjectTagging'
	| 'DeleteObjectTagging'
	| 'GetBucketAcl'
	| 'PutBucketAcl'
	| 'GetBucketVersioning'
	| 'PutBucketVersioning'
	| 'GetBucketPolicy'
	| 'PutBucketPolicy'
	| 'DeleteBucketPolicy'
	| 'GetBucketTagging'
	| 'PutBucketTagging'
	| 'DeleteBucketTagging'
	| 'GetBucketWebsite'
	| 'PutBucketWebsite'
	| 'DeleteBucketWebsite'
	| 'GetBucketLogging'
	| 'PutBucketLogging'
	| 'GetBucketNotification'
	| 'PutBucketNotification'
	| 'GetBucketReplication'
	| 'PutBucketReplication'
	| 'DeleteBucketReplication'
	| 'GetObjectLockConfiguration'
	| 'PutObjectLockConfiguration'
	| 'GetObjectRetention'
	| 'PutObjectRetention'
	| 'GetObjectLegalHold'
	| 'PutObjectLegalHold'
	| 'GetPublicAccessBlock'
	| 'PutPublicAccessBlock'
	| 'DeletePublicAccessBlock'
	| 'GetBucketAccelerateConfiguration'
	| 'PutBucketAccelerateConfiguration'
	| 'GetBucketRequestPayment'
	| 'PutBucketRequestPayment'
	| 'GetObjectAcl'
	| 'PutObjectAcl'
	| 'RestoreObject'
	| 'SelectObjectContent';

/** All S3 operations we detect from HTTP requests. */
export type S3OperationName = R2SupportedOperation | R2UnsupportedOperation;

/** Result of parsing an S3 request into an operation. */
export interface S3Operation {
	name: S3OperationName;
	/** IAM action, e.g. "s3:GetObject" */
	action: string;
	/** Resource string for policy evaluation, e.g. "object:my-bucket/path/to/key" */
	resource: string;
	/** Bucket name, if applicable */
	bucket?: string;
	/** Object key, if applicable */
	key?: string;
}

// ─── Sig V4 ─────────────────────────────────────────────────────────────────

/** Parsed components from the AWS Sig V4 Authorization header. */
export interface SigV4Components {
	accessKeyId: string;
	date: string;
	region: string;
	service: string;
	signedHeaders: string[];
	signature: string;
	credentialScope: string;
}

/** Result of inbound Sig V4 verification. */
export interface SigV4VerifyResult {
	valid: boolean;
	accessKeyId?: string;
	error?: string;
}
