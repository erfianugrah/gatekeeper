// ─── AWS IAM Policy Converter ───────────────────────────────────────
// Converts AWS IAM S3 policy documents to Gatekeeper's internal format.
// Extracted so it can be tested independently of the React component.
// Self-contained — does not import from other dashboard modules so that
// the worker test suite can import it directly.

// ─── Gatekeeper types (subset needed by the converter) ──────────────

export interface GkStatement {
	effect: 'allow' | 'deny';
	actions: string[];
	resources: string[];
}

export interface GkPolicyDocument {
	version: string;
	statements: GkStatement[];
}

// ─── AWS types ──────────────────────────────────────────────────────

export interface AwsStatement {
	Sid?: string;
	Effect: string;
	Action: string | string[];
	Resource: string | string[];
	Condition?: Record<string, Record<string, string>>;
}

export interface AwsPolicy {
	Version?: string;
	Statement: AwsStatement[];
}

export interface ConvertResult {
	policy: GkPolicyDocument;
	warnings: string[];
	skipped: string[];
}

// ─── Converter ──────────────────────────────────────────────────────

/** Convert an AWS IAM policy document into Gatekeeper's PolicyDocument format. */
export function convertAwsPolicy(aws: AwsPolicy): ConvertResult {
	const warnings: string[] = [];
	const skipped: string[] = [];
	const statements: GkStatement[] = [];

	for (const stmt of aws.Statement) {
		const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
		const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];

		if (stmt.Effect !== 'Allow' && stmt.Effect !== 'Deny') {
			skipped.push(`${stmt.Sid ?? 'Statement'}: Unsupported effect "${stmt.Effect}"`);
			continue;
		}
		const effect = stmt.Effect === 'Deny' ? 'deny' : 'allow';

		const s3Actions = actions.filter((a) => a.startsWith('s3:'));
		const nonS3Actions = actions.filter((a) => !a.startsWith('s3:'));

		if (s3Actions.length === 0) {
			skipped.push(
				`${stmt.Sid ?? 'Statement'}: No S3 actions (${nonS3Actions.slice(0, 3).join(', ')}${nonS3Actions.length > 3 ? '...' : ''})`,
			);
			continue;
		}

		if (nonS3Actions.length > 0) {
			warnings.push(`${stmt.Sid ?? 'Statement'}: Dropped non-S3 actions: ${nonS3Actions.join(', ')}`);
		}

		const converted = convertResources(resources, warnings, stmt.Sid);

		if (converted.length === 0) {
			statements.push({ effect, actions: s3Actions, resources: ['*'] });
		} else {
			statements.push({ effect, actions: s3Actions, resources: converted });
		}

		if (stmt.Condition) {
			warnings.push(`${stmt.Sid ?? 'Statement'}: AWS Conditions dropped — translate manually if needed`);
		}
	}

	if (statements.length === 0) {
		statements.push({ effect: 'allow', actions: ['s3:GetObject'], resources: ['*'] });
		warnings.push('No S3 statements found — added a placeholder');
	}

	return { policy: { version: '2025-01-01', statements }, warnings, skipped };
}

/** Convert AWS ARN resources to Gatekeeper resource format. */
export function convertResources(resources: string[], warnings: string[], sid?: string): string[] {
	const result: string[] = [];

	for (const resource of resources) {
		if (resource === '*') return [];

		const arnMatch = resource.match(/^arn:aws:s3:::(.+)$/);
		if (!arnMatch) {
			warnings.push(`${sid ?? 'Statement'}: Unrecognized resource format: ${resource}`);
			continue;
		}

		const path = arnMatch[1];
		const slashIndex = path.indexOf('/');
		if (slashIndex === -1) {
			const bucketName = path.replace(/\*+$/, '');
			if (path.includes('*') || path.includes('?')) {
				result.push(`bucket:${path}`);
				result.push(`object:${path}/*`);
				warnings.push(`${sid ?? 'Statement'}: Wildcard bucket "${path}" — use conditions for finer control`);
			} else {
				result.push(`bucket:${bucketName}`);
			}
		} else {
			const bucket = path.slice(0, slashIndex);
			const keyPattern = path.slice(slashIndex + 1);

			if (bucket.includes('*') || bucket.includes('?')) {
				result.push(`object:${bucket}/${keyPattern}`);
				warnings.push(`${sid ?? 'Statement'}: Wildcard bucket in object resource "${path}" — verify manually`);
			} else {
				result.push(`object:${bucket}/${keyPattern}`);
			}
		}
	}

	return result;
}
