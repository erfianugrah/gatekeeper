/**
 * R2 endpoint binding validation for S3 credential creation.
 *
 * Ensures the upstream R2 endpoint exists and that the credential's
 * policy resources are compatible with the endpoint's bucket scope.
 *
 * Rules:
 *   - All actions must be s3:* family
 *   - No resources: ["*"]
 *   - Endpoint with specific bucket_names -> resources must reference those buckets
 *   - Endpoint with "*" -> any bucket/object resource is fine
 */

import type { Gatekeeper } from '../durable-object';
import type { PolicyDocument } from '../policy-types';

// ─── Public validation entry point ──────────────────────────────────────────

export interface R2BindingResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validate that a policy's actions and resources are compatible with
 * the upstream R2 endpoint it's being bound to.
 */
export async function validateR2Binding(
	stub: DurableObjectStub<Gatekeeper>,
	upstreamTokenId: string,
	policy: PolicyDocument,
): Promise<R2BindingResult> {
	const errors: string[] = [];

	// 1. Resolve the upstream R2 endpoint metadata
	const endpointResult = await stub.getUpstreamR2(upstreamTokenId);
	if (!endpointResult) {
		return { valid: false, errors: [`Upstream R2 endpoint '${upstreamTokenId}' not found`] };
	}

	const bucketNames = endpointResult.endpoint.bucket_names.split(',').map((s) => s.trim());
	const isWildcard = bucketNames.length === 1 && bucketNames[0] === '*';

	// 2. Validate each statement
	for (let i = 0; i < policy.statements.length; i++) {
		const stmt = policy.statements[i];
		const prefix = `statements[${i}]`;

		// 2a. Actions must be s3:* family
		for (const action of stmt.actions) {
			if (!action.startsWith('s3:')) {
				errors.push(`${prefix}.actions: '${action}' is not valid for an S3 credential (must start with 's3:')`);
			}
		}

		// 2b. Reject bare wildcard resources
		for (const resource of stmt.resources) {
			if (resource === '*') {
				errors.push(
					`${prefix}.resources: wildcard '*' is not allowed — use explicit scoping (e.g. 'bucket:<name>' or 'object:<bucket>/<key>')`,
				);
				continue;
			}

			// 2c. Validate bucket references against endpoint scope
			if (isWildcard) continue; // Wildcard endpoint allows any bucket

			const bucket = extractBucketFromResource(resource);
			if (bucket && bucket !== '*' && !bucketNames.includes(bucket)) {
				errors.push(
					`${prefix}.resources: bucket '${bucket}' is not covered by the upstream R2 endpoint (allowed: ${bucketNames.join(', ')})`,
				);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract the bucket name from a resource string like "bucket:foo" or "object:foo/bar". */
function extractBucketFromResource(resource: string): string | null {
	if (resource.startsWith('bucket:')) {
		return resource.slice('bucket:'.length);
	}
	if (resource.startsWith('object:')) {
		const rest = resource.slice('object:'.length);
		const slash = rest.indexOf('/');
		return slash === -1 ? rest : rest.slice(0, slash);
	}
	return null;
}
