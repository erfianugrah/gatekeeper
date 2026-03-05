import { describe, it, expect } from 'vitest';
import { detectOperation, parsePath, buildConditionFields } from '../src/s3/operations';

// --- Path parsing ---

describe('S3 operations — path parsing', () => {
	it('empty path -> no bucket or key', () => {
		expect(parsePath('')).toEqual({});
		expect(parsePath('/')).toEqual({});
	});

	it('single segment -> bucket only', () => {
		expect(parsePath('/my-bucket')).toEqual({ bucket: 'my-bucket' });
		expect(parsePath('my-bucket')).toEqual({ bucket: 'my-bucket' });
	});

	it('two segments -> bucket + key', () => {
		expect(parsePath('/my-bucket/key.txt')).toEqual({ bucket: 'my-bucket', key: 'key.txt' });
	});

	it('multi-segment key preserved', () => {
		expect(parsePath('/bucket/path/to/deep/key.txt')).toEqual({
			bucket: 'bucket',
			key: 'path/to/deep/key.txt',
		});
	});

	it('URL-encoded segments decoded', () => {
		expect(parsePath('/my%20bucket/my%20key.txt')).toEqual({
			bucket: 'my bucket',
			key: 'my key.txt',
		});
	});
});

// --- Operation detection ---

describe('S3 operations — detection', () => {
	function detect(method: string, path: string, query: Record<string, string> = {}, hdrs: Record<string, string> = {}) {
		const params = new URLSearchParams(query);
		const headers = new Headers(hdrs);
		return detectOperation(method, path, params, headers);
	}

	// Root-level
	it('GET / -> ListBuckets', () => {
		const op = detect('GET', '/');
		expect(op.name).toBe('ListBuckets');
		expect(op.action).toBe('s3:ListAllMyBuckets');
		expect(op.resource).toBe('account:*');
	});

	// Bucket-level
	it('GET /bucket?list-type=2 -> ListObjectsV2', () => {
		const op = detect('GET', '/bucket', { 'list-type': '2' });
		expect(op.name).toBe('ListObjectsV2');
		expect(op.action).toBe('s3:ListBucket');
		expect(op.resource).toBe('bucket:bucket');
	});

	it('GET /bucket -> ListObjects', () => {
		const op = detect('GET', '/bucket');
		expect(op.name).toBe('ListObjects');
	});

	it('GET /bucket?uploads -> ListMultipartUploads', () => {
		const op = detect('GET', '/bucket', { uploads: '' });
		expect(op.name).toBe('ListMultipartUploads');
	});

	it('HEAD /bucket -> HeadBucket', () => {
		const op = detect('HEAD', '/bucket');
		expect(op.name).toBe('HeadBucket');
		expect(op.action).toBe('s3:HeadBucket');
	});

	it('PUT /bucket -> CreateBucket', () => {
		const op = detect('PUT', '/bucket');
		expect(op.name).toBe('CreateBucket');
	});

	it('DELETE /bucket -> DeleteBucket', () => {
		const op = detect('DELETE', '/bucket');
		expect(op.name).toBe('DeleteBucket');
	});

	it('POST /bucket?delete -> DeleteObjects', () => {
		const op = detect('POST', '/bucket', { delete: '' });
		expect(op.name).toBe('DeleteObjects');
		expect(op.action).toBe('s3:DeleteObject');
	});

	it('GET /bucket?cors -> GetBucketCors', () => {
		const op = detect('GET', '/bucket', { cors: '' });
		expect(op.name).toBe('GetBucketCors');
	});

	it('GET /bucket?lifecycle -> GetBucketLifecycle', () => {
		const op = detect('GET', '/bucket', { lifecycle: '' });
		expect(op.name).toBe('GetBucketLifecycle');
	});

	it('GET /bucket?location -> GetBucketLocation', () => {
		const op = detect('GET', '/bucket', { location: '' });
		expect(op.name).toBe('GetBucketLocation');
	});

	it('GET /bucket?encryption -> GetBucketEncryption', () => {
		const op = detect('GET', '/bucket', { encryption: '' });
		expect(op.name).toBe('GetBucketEncryption');
	});

	// Object-level
	it('GET /bucket/key.txt -> GetObject', () => {
		const op = detect('GET', '/bucket/key.txt');
		expect(op.name).toBe('GetObject');
		expect(op.action).toBe('s3:GetObject');
		expect(op.resource).toBe('object:bucket/key.txt');
		expect(op.bucket).toBe('bucket');
		expect(op.key).toBe('key.txt');
	});

	it('HEAD /bucket/key.txt -> HeadObject', () => {
		const op = detect('HEAD', '/bucket/key.txt');
		expect(op.name).toBe('HeadObject');
		expect(op.action).toBe('s3:GetObject');
	});

	it('PUT /bucket/key.txt -> PutObject', () => {
		const op = detect('PUT', '/bucket/key.txt');
		expect(op.name).toBe('PutObject');
		expect(op.action).toBe('s3:PutObject');
	});

	it('DELETE /bucket/key.txt -> DeleteObject', () => {
		const op = detect('DELETE', '/bucket/key.txt');
		expect(op.name).toBe('DeleteObject');
		expect(op.action).toBe('s3:DeleteObject');
	});

	it('PUT /bucket/key.txt with x-amz-copy-source -> CopyObject', () => {
		const op = detect('PUT', '/bucket/key.txt', {}, { 'x-amz-copy-source': '/src-bucket/src-key' });
		expect(op.name).toBe('CopyObject');
		expect(op.action).toBe('s3:PutObject');
	});

	it('GET /bucket/key.txt?tagging -> GetObjectTagging', () => {
		const op = detect('GET', '/bucket/key.txt', { tagging: '' });
		expect(op.name).toBe('GetObjectTagging');
	});

	it('PUT /bucket/key.txt?tagging -> PutObjectTagging', () => {
		const op = detect('PUT', '/bucket/key.txt', { tagging: '' });
		expect(op.name).toBe('PutObjectTagging');
	});

	it('DELETE /bucket/key.txt?tagging -> DeleteObjectTagging', () => {
		const op = detect('DELETE', '/bucket/key.txt', { tagging: '' });
		expect(op.name).toBe('DeleteObjectTagging');
	});

	// Multipart
	it('POST /bucket/key?uploads -> CreateMultipartUpload', () => {
		const op = detect('POST', '/bucket/key', { uploads: '' });
		expect(op.name).toBe('CreateMultipartUpload');
		expect(op.action).toBe('s3:PutObject');
	});

	it('PUT /bucket/key?uploadId=123 -> UploadPart', () => {
		const op = detect('PUT', '/bucket/key', { uploadId: '123' });
		expect(op.name).toBe('UploadPart');
	});

	it('PUT /bucket/key?uploadId=123 with copy source -> UploadPartCopy', () => {
		const op = detect('PUT', '/bucket/key', { uploadId: '123' }, { 'x-amz-copy-source': '/b/k' });
		expect(op.name).toBe('UploadPartCopy');
	});

	it('POST /bucket/key?uploadId=123 -> CompleteMultipartUpload', () => {
		const op = detect('POST', '/bucket/key', { uploadId: '123' });
		expect(op.name).toBe('CompleteMultipartUpload');
	});

	it('DELETE /bucket/key?uploadId=123 -> AbortMultipartUpload', () => {
		const op = detect('DELETE', '/bucket/key', { uploadId: '123' });
		expect(op.name).toBe('AbortMultipartUpload');
	});

	it('GET /bucket/key?uploadId=123 -> ListParts', () => {
		const op = detect('GET', '/bucket/key', { uploadId: '123' });
		expect(op.name).toBe('ListParts');
	});
});

// --- Condition fields ---

describe('S3 operations — condition fields', () => {
	it('builds key-derived fields for object operations', () => {
		const op = detectOperation('GET', '/my-bucket/images/photo.jpg', new URLSearchParams(), new Headers());
		const fields = buildConditionFields(op, 'GET', new Headers(), new URLSearchParams());

		expect(fields.method).toBe('GET');
		expect(fields.bucket).toBe('my-bucket');
		expect(fields.key).toBe('images/photo.jpg');
		expect(fields['key.prefix']).toBe('images/');
		expect(fields['key.filename']).toBe('photo.jpg');
		expect(fields['key.extension']).toBe('jpg');
	});

	it('handles key without extension', () => {
		const op = detectOperation('GET', '/bucket/no-ext', new URLSearchParams(), new Headers());
		const fields = buildConditionFields(op, 'GET', new Headers(), new URLSearchParams());

		expect(fields.key).toBe('no-ext');
		expect(fields['key.filename']).toBe('no-ext');
		expect(fields['key.extension']).toBeUndefined();
	});

	it('handles key without prefix (root-level)', () => {
		const op = detectOperation('GET', '/bucket/file.txt', new URLSearchParams(), new Headers());
		const fields = buildConditionFields(op, 'GET', new Headers(), new URLSearchParams());

		expect(fields['key.prefix']).toBe('');
		expect(fields['key.filename']).toBe('file.txt');
	});

	it('includes content-type and content-length for PutObject', () => {
		const headers = new Headers({
			'content-type': 'image/jpeg',
			'content-length': '1048576',
		});
		const op = detectOperation('PUT', '/bucket/photo.jpg', new URLSearchParams(), headers);
		const fields = buildConditionFields(op, 'PUT', headers, new URLSearchParams());

		expect(fields.content_type).toBe('image/jpeg');
		expect(fields.content_length).toBe('1048576');
	});

	it('parses x-amz-copy-source for CopyObject', () => {
		const headers = new Headers({
			'x-amz-copy-source': '/source-bucket/source/key.txt',
		});
		const op = detectOperation('PUT', '/dest-bucket/dest-key.txt', new URLSearchParams(), headers);
		const fields = buildConditionFields(op, 'PUT', headers, new URLSearchParams());

		expect(fields.source_bucket).toBe('source-bucket');
		expect(fields.source_key).toBe('source/key.txt');
	});

	it('includes list_prefix for ListObjects', () => {
		const params = new URLSearchParams({ 'list-type': '2', prefix: 'images/' });
		const op = detectOperation('GET', '/bucket', params, new Headers());
		const fields = buildConditionFields(op, 'GET', new Headers(), params);

		expect(fields.list_prefix).toBe('images/');
	});
});

// --- Extended S3 operation detection (ops R2 may or may not support — we detect for IAM, forward to R2 regardless) ---

describe('S3 operations — extended detection (bucket-level)', () => {
	it('GET ?acl -> GetBucketAcl', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ acl: '' }), new Headers());
		expect(op.name).toBe('GetBucketAcl');
		expect(op.action).toBe('s3:GetBucketAcl');
	});

	it('PUT ?acl -> PutBucketAcl', () => {
		const op = detectOperation('PUT', '/bucket', new URLSearchParams({ acl: '' }), new Headers());
		expect(op.name).toBe('PutBucketAcl');
	});

	it('GET ?versioning -> GetBucketVersioning', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ versioning: '' }), new Headers());
		expect(op.name).toBe('GetBucketVersioning');
	});

	it('PUT ?versioning -> PutBucketVersioning', () => {
		const op = detectOperation('PUT', '/bucket', new URLSearchParams({ versioning: '' }), new Headers());
		expect(op.name).toBe('PutBucketVersioning');
	});

	it('GET ?policy -> GetBucketPolicy', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ policy: '' }), new Headers());
		expect(op.name).toBe('GetBucketPolicy');
	});

	it('PUT ?policy -> PutBucketPolicy', () => {
		const op = detectOperation('PUT', '/bucket', new URLSearchParams({ policy: '' }), new Headers());
		expect(op.name).toBe('PutBucketPolicy');
	});

	it('DELETE ?policy -> DeleteBucketPolicy', () => {
		const op = detectOperation('DELETE', '/bucket', new URLSearchParams({ policy: '' }), new Headers());
		expect(op.name).toBe('DeleteBucketPolicy');
	});

	it('GET ?tagging (bucket) -> GetBucketTagging', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ tagging: '' }), new Headers());
		expect(op.name).toBe('GetBucketTagging');
	});

	it('GET ?website -> GetBucketWebsite', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ website: '' }), new Headers());
		expect(op.name).toBe('GetBucketWebsite');
	});

	it('GET ?logging -> GetBucketLogging', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ logging: '' }), new Headers());
		expect(op.name).toBe('GetBucketLogging');
	});

	it('GET ?notification -> GetBucketNotification', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ notification: '' }), new Headers());
		expect(op.name).toBe('GetBucketNotification');
	});

	it('GET ?replication -> GetBucketReplication', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ replication: '' }), new Headers());
		expect(op.name).toBe('GetBucketReplication');
	});

	it('GET ?object-lock -> GetObjectLockConfiguration', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ 'object-lock': '' }), new Headers());
		expect(op.name).toBe('GetObjectLockConfiguration');
	});

	it('GET ?publicAccessBlock -> GetPublicAccessBlock', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ publicAccessBlock: '' }), new Headers());
		expect(op.name).toBe('GetPublicAccessBlock');
	});

	it('GET ?accelerate -> GetBucketAccelerateConfiguration', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ accelerate: '' }), new Headers());
		expect(op.name).toBe('GetBucketAccelerateConfiguration');
	});

	it('GET ?requestPayment -> GetBucketRequestPayment', () => {
		const op = detectOperation('GET', '/bucket', new URLSearchParams({ requestPayment: '' }), new Headers());
		expect(op.name).toBe('GetBucketRequestPayment');
	});

	it('DELETE ?tagging (bucket) -> DeleteBucketTagging', () => {
		const op = detectOperation('DELETE', '/bucket', new URLSearchParams({ tagging: '' }), new Headers());
		expect(op.name).toBe('DeleteBucketTagging');
	});

	it('DELETE ?website -> DeleteBucketWebsite', () => {
		const op = detectOperation('DELETE', '/bucket', new URLSearchParams({ website: '' }), new Headers());
		expect(op.name).toBe('DeleteBucketWebsite');
	});

	it('DELETE ?replication -> DeleteBucketReplication', () => {
		const op = detectOperation('DELETE', '/bucket', new URLSearchParams({ replication: '' }), new Headers());
		expect(op.name).toBe('DeleteBucketReplication');
	});

	it('DELETE ?publicAccessBlock -> DeletePublicAccessBlock', () => {
		const op = detectOperation('DELETE', '/bucket', new URLSearchParams({ publicAccessBlock: '' }), new Headers());
		expect(op.name).toBe('DeletePublicAccessBlock');
	});
});

describe('S3 operations — extended detection (object-level)', () => {
	it('GET ?acl (object) -> GetObjectAcl', () => {
		const op = detectOperation('GET', '/bucket/key.txt', new URLSearchParams({ acl: '' }), new Headers());
		expect(op.name).toBe('GetObjectAcl');
		expect(op.action).toBe('s3:GetObjectAcl');
	});

	it('PUT ?acl (object) -> PutObjectAcl', () => {
		const op = detectOperation('PUT', '/bucket/key.txt', new URLSearchParams({ acl: '' }), new Headers());
		expect(op.name).toBe('PutObjectAcl');
	});

	it('GET ?retention -> GetObjectRetention', () => {
		const op = detectOperation('GET', '/bucket/key.txt', new URLSearchParams({ retention: '' }), new Headers());
		expect(op.name).toBe('GetObjectRetention');
	});

	it('PUT ?retention -> PutObjectRetention', () => {
		const op = detectOperation('PUT', '/bucket/key.txt', new URLSearchParams({ retention: '' }), new Headers());
		expect(op.name).toBe('PutObjectRetention');
	});

	it('GET ?legal-hold -> GetObjectLegalHold', () => {
		const op = detectOperation('GET', '/bucket/key.txt', new URLSearchParams({ 'legal-hold': '' }), new Headers());
		expect(op.name).toBe('GetObjectLegalHold');
	});

	it('PUT ?legal-hold -> PutObjectLegalHold', () => {
		const op = detectOperation('PUT', '/bucket/key.txt', new URLSearchParams({ 'legal-hold': '' }), new Headers());
		expect(op.name).toBe('PutObjectLegalHold');
	});

	it('POST ?restore -> RestoreObject', () => {
		const op = detectOperation('POST', '/bucket/key.txt', new URLSearchParams({ restore: '' }), new Headers());
		expect(op.name).toBe('RestoreObject');
	});
});
