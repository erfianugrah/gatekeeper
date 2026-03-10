/**
 * Shared S3 test utilities — helpers, clients, mocks, and policy factories.
 * Used by all s3-e2e-*.test.ts files and s3-credentials.test.ts.
 */

import { env, SELF, fetchMock } from 'cloudflare:test';
import { AwsClient } from 'aws4fetch';
import { adminHeaders } from './helpers';

// ─── R2 upstream constants ──────────────────────────────────────────────────

export const R2_TEST_ENDPOINT = 'https://facefacefacefacefacefacefaceface.r2.cloudflarestorage.com';
export const R2_TEST_ACCESS_KEY = 'ebd50f0dc5491e61ad0cd72030a8f314';
export const R2_TEST_SECRET_KEY = 'baeace5387c23acf0ad2b582a808a13073e9a09acdf0b54742420229461640f4';

export function getR2Origin(): string {
	return new URL(R2_TEST_ENDPOINT).origin;
}

// ─── Cleanup tracker ────────────────────────────────────────────────────────

/** IDs of upstream R2 endpoints created during tests. */
const createdUpstreamR2Ids: string[] = [];

/** Access key IDs of S3 credentials created during tests. */
const createdS3CredentialIds: string[] = [];

/** Revoke an S3 credential via the admin API. */
async function deleteS3Credential(accessKeyId: string): Promise<void> {
	await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
		method: 'DELETE',
		headers: adminHeaders(),
	});
}

/** Delete an upstream R2 endpoint via the admin API. */
async function deleteUpstreamR2(id: string): Promise<void> {
	await SELF.fetch(`http://localhost/admin/upstream-r2/${id}`, {
		method: 'DELETE',
		headers: adminHeaders(),
	});
}

/** Revoke all S3 credentials and upstream R2 endpoints created via tracked helpers. Call in afterAll. */
export async function cleanupCreatedS3Resources(): Promise<void> {
	const credDeletes = createdS3CredentialIds.splice(0).map((id) => deleteS3Credential(id));
	const r2Deletes = createdUpstreamR2Ids.splice(0).map((id) => deleteUpstreamR2(id));
	await Promise.all([...credDeletes, ...r2Deletes]);
}

// ─── R2 upstream registration ───────────────────────────────────────────────

/** Register a wildcard upstream R2 endpoint. Call in beforeAll. Auto-tracked for cleanup. Sets currentR2EndpointId. */
export async function registerUpstreamR2(bucketNames: string[] = ['*']): Promise<string> {
	const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({
			name: 'test-r2',
			access_key_id: R2_TEST_ACCESS_KEY,
			secret_access_key: R2_TEST_SECRET_KEY,
			endpoint: R2_TEST_ENDPOINT,
			bucket_names: bucketNames,
		}),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`registerUpstreamR2 failed: ${JSON.stringify(data.errors)}`);
	createdUpstreamR2Ids.push(data.result.id);
	currentR2EndpointId = data.result.id;
	return data.result.id;
}

// ─── Credential management ──────────────────────────────────────────────────

/** Create an S3 credential via admin API and return both keys. Auto-tracked for cleanup. */
export async function createCredential(policy: Record<string, unknown>, name = 'e2e-test-cred') {
	const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ name, policy, upstream_token_id: currentR2EndpointId }),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`createCredential failed: ${JSON.stringify(data.errors)}`);
	const accessKeyId = data.result.credential.access_key_id as string;
	createdS3CredentialIds.push(accessKeyId);
	return {
		accessKeyId,
		secretAccessKey: data.result.credential.secret_access_key as string,
	};
}

// ─── R2 binding state ───────────────────────────────────────────────────────

/** Current upstream R2 endpoint ID. Set by registerUpstreamR2(). Used by createCredential(). */
let currentR2EndpointId = '';

/** Get the current upstream R2 endpoint ID. */
export function getR2EndpointId(): string {
	return currentR2EndpointId;
}

// ─── Client + signing ───────────────────────────────────────────────────────

/** Build an AwsClient pointed at our proxy. */
export function buildClient(accessKeyId: string, secretAccessKey: string): AwsClient {
	return new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto',
	});
}

/** Sign a request and send it through SELF.fetch. */
export async function signedFetch(client: AwsClient, url: string, init?: RequestInit): Promise<Response> {
	const signed = await client.sign(url, {
		method: init?.method || 'GET',
		headers: init?.headers as HeadersInit | undefined,
		body: init?.body,
	});
	return SELF.fetch(signed);
}

/** Sign a request as a presigned URL (query string auth) and send it through SELF.fetch. */
export async function presignedFetch(client: AwsClient, url: string, init?: RequestInit & { expiresIn?: number }): Promise<Response> {
	let signUrl = url;
	if (init?.expiresIn) {
		const u = new URL(url);
		u.searchParams.set('X-Amz-Expires', String(init.expiresIn));
		signUrl = u.toString();
	}

	const signed = await client.sign(signUrl, {
		method: init?.method || 'GET',
		headers: init?.headers as HeadersInit | undefined,
		body: init?.body,
		aws: { signQuery: true },
	});
	return SELF.fetch(signed);
}

// ─── R2 mock ────────────────────────────────────────────────────────────────

/** Mock R2 to return a given status/body for a specific method+path. */
export function mockR2(method: string, path: string | RegExp, status: number, body: string, headers?: Record<string, string>) {
	fetchMock
		.get(getR2Origin())
		.intercept({ method, path })
		.reply(status, body, {
			headers: { 'Content-Type': 'application/xml', ...headers },
		});
}

// ─── Policy factories ───────────────────────────────────────────────────────

export function s3WildcardPolicy() {
	return {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', 'bucket:*', 'object:*'] }],
	};
}

export function s3ReadOnlyPolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:ListBucket'],
				resources: [`bucket:${bucket}`, `object:${bucket}/*`],
			},
		],
	};
}

export function s3WriteOnlyPolicy(bucket: string, prefix?: string) {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:PutObject'],
				resources: [`object:${bucket}/*`],
				...(prefix
					? {
							conditions: [
								{
									field: 'key',
									operator: 'starts_with',
									value: prefix,
								},
							],
						}
					: {}),
			},
		],
	};
}

export function s3BucketAdminPolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: [
					's3:ListBucket',
					's3:GetBucketCors',
					's3:PutBucketCors',
					's3:DeleteBucketCors',
					's3:GetLifecycleConfiguration',
					's3:PutLifecycleConfiguration',
					's3:GetBucketLocation',
					's3:GetEncryptionConfiguration',
					's3:HeadBucket',
					's3:ListBucketMultipartUploads',
				],
				resources: [`bucket:${bucket}`],
			},
		],
	};
}

export function s3DeletePolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:DeleteObject'],
				resources: [`object:${bucket}/*`],
			},
		],
	};
}

export function s3MultipartPolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
				resources: [`object:${bucket}/*`],
			},
			{
				effect: 'allow',
				actions: ['s3:ListBucketMultipartUploads'],
				resources: [`bucket:${bucket}`],
			},
		],
	};
}

export function s3ExtensionPolicy(bucket: string, extension: string) {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:PutObject', 's3:GetObject'],
				resources: [`object:${bucket}/*`],
				conditions: [
					{
						field: 'key.extension',
						operator: 'eq',
						value: extension,
					},
				],
			},
		],
	};
}

export function s3ContentTypePolicy(bucket: string, contentType: string) {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:PutObject'],
				resources: [`object:${bucket}/*`],
				conditions: [
					{
						field: 'content_type',
						operator: 'starts_with',
						value: contentType,
					},
				],
			},
		],
	};
}

export function s3MultiStatementPolicy() {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:ListBucket'],
				resources: ['bucket:read-bucket', 'object:read-bucket/*'],
			},
			{
				effect: 'allow',
				actions: ['s3:PutObject', 's3:DeleteObject'],
				resources: ['object:write-bucket/*'],
			},
			{
				effect: 'allow',
				actions: ['s3:ListAllMyBuckets'],
				resources: ['account:*'],
			},
		],
	};
}
