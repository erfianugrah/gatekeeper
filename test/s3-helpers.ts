/**
 * Shared S3 test utilities — helpers, clients, mocks, and policy factories.
 * Used by all s3-e2e-*.test.ts files and s3-credentials.test.ts.
 */

import { env, SELF, fetchMock } from 'cloudflare:test';
import { AwsClient } from 'aws4fetch';
import { adminHeaders } from './helpers';

// ─── R2 origin ──────────────────────────────────────────────────────────────

export function getR2Origin(): string {
	const endpoint = env.R2_ENDPOINT;
	const url = new URL(endpoint);
	return url.origin;
}

// ─── Credential management ──────────────────────────────────────────────────

/** Create an S3 credential via admin API and return both keys. */
export async function createCredential(
	policy: Record<string, unknown>,
	name = 'e2e-test-cred',
) {
	const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ name, policy }),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`createCredential failed: ${JSON.stringify(data.errors)}`);
	return {
		accessKeyId: data.result.credential.access_key_id as string,
		secretAccessKey: data.result.credential.secret_access_key as string,
	};
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
export async function signedFetch(
	client: AwsClient,
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const signed = await client.sign(url, {
		method: init?.method || 'GET',
		headers: init?.headers as HeadersInit | undefined,
		body: init?.body,
	});
	return SELF.fetch(signed);
}

/** Sign a request as a presigned URL (query string auth) and send it through SELF.fetch. */
export async function presignedFetch(
	client: AwsClient,
	url: string,
	init?: RequestInit & { expiresIn?: number },
): Promise<Response> {
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
		statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['*'] }],
	};
}

export function s3ReadOnlyPolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:GetObject', 's3:ListBucket'],
			resources: [`bucket:${bucket}`, `object:${bucket}/*`],
		}],
	};
}

export function s3WriteOnlyPolicy(bucket: string, prefix?: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:PutObject'],
			resources: [`object:${bucket}/*`],
			...(prefix ? {
				conditions: [{
					field: 'key',
					operator: 'starts_with',
					value: prefix,
				}],
			} : {}),
		}],
	};
}

export function s3BucketAdminPolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:ListBucket', 's3:GetBucketCors', 's3:PutBucketCors', 's3:DeleteBucketCors',
				's3:GetLifecycleConfiguration', 's3:PutLifecycleConfiguration',
				's3:GetBucketLocation', 's3:GetEncryptionConfiguration', 's3:HeadBucket',
				's3:ListBucketMultipartUploads'],
			resources: [`bucket:${bucket}`],
		}],
	};
}

export function s3DeletePolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:DeleteObject'],
			resources: [`object:${bucket}/*`],
		}],
	};
}

export function s3MultipartPolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
			resources: [`object:${bucket}/*`],
		}, {
			effect: 'allow',
			actions: ['s3:ListBucketMultipartUploads'],
			resources: [`bucket:${bucket}`],
		}],
	};
}

export function s3ExtensionPolicy(bucket: string, extension: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:PutObject', 's3:GetObject'],
			resources: [`object:${bucket}/*`],
			conditions: [{
				field: 'key.extension',
				operator: 'eq',
				value: extension,
			}],
		}],
	};
}

export function s3ContentTypePolicy(bucket: string, contentType: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:PutObject'],
			resources: [`object:${bucket}/*`],
			conditions: [{
				field: 'content_type',
				operator: 'starts_with',
				value: contentType,
			}],
		}],
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
