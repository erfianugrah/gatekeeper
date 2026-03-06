import { describe, it, expect } from 'vitest';
import { convertAwsPolicy, convertResources } from '../dashboard/src/lib/aws-policy-converter';
import type { AwsPolicy } from '../dashboard/src/lib/aws-policy-converter';

// --- Helpers ---

function aws(stmts: AwsPolicy['Statement']): AwsPolicy {
	return { Version: '2012-10-17', Statement: stmts };
}

// ─── convertAwsPolicy ───────────────────────────────────────────────────────

describe('convertAwsPolicy', () => {
	// --- Basic conversions ---

	it('converts a single Allow S3 statement with wildcard resource', () => {
		const result = convertAwsPolicy(aws([{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }]));
		expect(result.policy.version).toBe('2025-01-01');
		expect(result.policy.statements).toHaveLength(1);
		expect(result.policy.statements[0]).toEqual({
			effect: 'allow',
			actions: ['s3:GetObject'],
			resources: ['*'],
		});
		expect(result.warnings).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});

	it('converts Allow -> allow and Deny -> deny', () => {
		const result = convertAwsPolicy(
			aws([
				{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
				{ Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' },
			]),
		);
		expect(result.policy.statements).toHaveLength(2);
		expect(result.policy.statements[0].effect).toBe('allow');
		expect(result.policy.statements[1].effect).toBe('deny');
	});

	it('handles Action as array', () => {
		const result = convertAwsPolicy(aws([{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: '*' }]));
		expect(result.policy.statements[0].actions).toEqual(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']);
	});

	it('handles Resource as array', () => {
		const result = convertAwsPolicy(
			aws([{ Effect: 'Allow', Action: 's3:GetObject', Resource: ['arn:aws:s3:::my-bucket', 'arn:aws:s3:::my-bucket/*'] }]),
		);
		expect(result.policy.statements[0].resources).toEqual(['bucket:my-bucket', 'object:my-bucket/*']);
	});

	it('preserves Sid in warnings/skipped messages', () => {
		const result = convertAwsPolicy(aws([{ Sid: 'ReadAccess', Effect: 'Allow', Action: ['s3:GetObject', 'iam:GetRole'], Resource: '*' }]));
		expect(result.warnings[0]).toContain('ReadAccess');
		expect(result.warnings[0]).toContain('iam:GetRole');
	});

	// --- Filtering non-S3 actions ---

	it('drops non-S3 actions with warning', () => {
		const result = convertAwsPolicy(aws([{ Effect: 'Allow', Action: ['s3:GetObject', 'iam:PassRole', 'sts:AssumeRole'], Resource: '*' }]));
		expect(result.policy.statements[0].actions).toEqual(['s3:GetObject']);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('iam:PassRole');
		expect(result.warnings[0]).toContain('sts:AssumeRole');
	});

	it('skips statements with no S3 actions at all', () => {
		const result = convertAwsPolicy(
			aws([
				{ Effect: 'Allow', Action: ['iam:ListUsers', 'sts:GetCallerIdentity'], Resource: '*' },
				{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
			]),
		);
		expect(result.policy.statements).toHaveLength(1);
		expect(result.policy.statements[0].actions).toEqual(['s3:GetObject']);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toContain('No S3 actions');
	});

	// --- Unsupported effects ---

	it('skips statements with unsupported effect', () => {
		const result = convertAwsPolicy(
			aws([{ Effect: 'Forbid', Action: 's3:GetObject', Resource: '*' } as any, { Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }]),
		);
		expect(result.policy.statements).toHaveLength(1);
		expect(result.policy.statements[0].effect).toBe('allow');
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toContain('Unsupported effect');
	});

	// --- AWS Conditions ---

	it('drops AWS Conditions with warning', () => {
		const result = convertAwsPolicy(
			aws([
				{
					Effect: 'Allow',
					Action: 's3:GetObject',
					Resource: 'arn:aws:s3:::my-bucket/*',
					Condition: { StringLike: { 's3:prefix': 'public/*' } },
				},
			]),
		);
		expect(result.policy.statements).toHaveLength(1);
		expect(result.warnings.some((w) => w.includes('Conditions dropped'))).toBe(true);
	});

	// --- Placeholder fallback ---

	it('adds placeholder when no S3 statements are found', () => {
		const result = convertAwsPolicy(aws([{ Effect: 'Allow', Action: 'iam:ListUsers', Resource: '*' }]));
		expect(result.policy.statements).toHaveLength(1);
		expect(result.policy.statements[0]).toEqual({
			effect: 'allow',
			actions: ['s3:GetObject'],
			resources: ['*'],
		});
		expect(result.warnings.some((w) => w.includes('placeholder'))).toBe(true);
	});

	it('adds placeholder for empty Statement array', () => {
		const result = convertAwsPolicy(aws([]));
		expect(result.policy.statements).toHaveLength(1);
		expect(result.policy.statements[0].actions).toEqual(['s3:GetObject']);
		expect(result.warnings.some((w) => w.includes('placeholder'))).toBe(true);
	});

	// --- s3:* wildcard ---

	it('preserves s3:* wildcard action', () => {
		const result = convertAwsPolicy(aws([{ Effect: 'Allow', Action: 's3:*', Resource: '*' }]));
		expect(result.policy.statements[0].actions).toEqual(['s3:*']);
	});

	// --- Multiple statements ---

	it('converts multiple statements preserving order', () => {
		const result = convertAwsPolicy(
			aws([
				{ Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: 'arn:aws:s3:::prod-data' },
				{ Effect: 'Deny', Action: 's3:DeleteObject', Resource: 'arn:aws:s3:::prod-data/*' },
				{ Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::staging-data/*' },
			]),
		);
		expect(result.policy.statements).toHaveLength(3);
		expect(result.policy.statements[0].effect).toBe('allow');
		expect(result.policy.statements[0].actions).toEqual(['s3:GetObject', 's3:ListBucket']);
		expect(result.policy.statements[0].resources).toEqual(['bucket:prod-data']);
		expect(result.policy.statements[1].effect).toBe('deny');
		expect(result.policy.statements[1].actions).toEqual(['s3:DeleteObject']);
		expect(result.policy.statements[1].resources).toEqual(['object:prod-data/*']);
		expect(result.policy.statements[2].effect).toBe('allow');
		expect(result.policy.statements[2].actions).toEqual(['s3:PutObject']);
		expect(result.policy.statements[2].resources).toEqual(['object:staging-data/*']);
	});

	// --- Realistic AWS policy ---

	it('converts a realistic read-only AWS policy', () => {
		const awsPolicy: AwsPolicy = {
			Version: '2012-10-17',
			Statement: [
				{
					Sid: 'ListBucket',
					Effect: 'Allow',
					Action: ['s3:ListBucket', 's3:GetBucketLocation'],
					Resource: 'arn:aws:s3:::my-assets',
				},
				{
					Sid: 'ReadObjects',
					Effect: 'Allow',
					Action: ['s3:GetObject', 's3:GetObjectVersion'],
					Resource: 'arn:aws:s3:::my-assets/*',
				},
			],
		};
		const result = convertAwsPolicy(awsPolicy);
		expect(result.policy.statements).toHaveLength(2);
		expect(result.policy.statements[0].resources).toEqual(['bucket:my-assets']);
		expect(result.policy.statements[1].resources).toEqual(['object:my-assets/*']);
		expect(result.skipped).toHaveLength(0);
	});

	it('converts a realistic full-access AWS policy with deny', () => {
		const awsPolicy: AwsPolicy = {
			Version: '2012-10-17',
			Statement: [
				{
					Sid: 'AllowAll',
					Effect: 'Allow',
					Action: 's3:*',
					Resource: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'],
				},
				{
					Sid: 'DenyDeleteProd',
					Effect: 'Deny',
					Action: ['s3:DeleteObject', 's3:DeleteBucket'],
					Resource: ['arn:aws:s3:::production', 'arn:aws:s3:::production/*'],
				},
			],
		};
		const result = convertAwsPolicy(awsPolicy);
		expect(result.policy.statements).toHaveLength(2);
		// Wildcard bucket ARN: arn:aws:s3:::* → bucket:* + object:*/*
		expect(result.policy.statements[0].resources).toContain('bucket:*');
		expect(result.policy.statements[1].effect).toBe('deny');
		expect(result.policy.statements[1].actions).toEqual(['s3:DeleteObject', 's3:DeleteBucket']);
		expect(result.policy.statements[1].resources).toContain('bucket:production');
		expect(result.policy.statements[1].resources).toContain('object:production/*');
	});

	it('handles mixed S3 and non-S3 statements in a real-world policy', () => {
		const awsPolicy: AwsPolicy = {
			Version: '2012-10-17',
			Statement: [
				{
					Sid: 'AssumeRole',
					Effect: 'Allow',
					Action: 'sts:AssumeRole',
					Resource: 'arn:aws:iam::123456789012:role/S3Access',
				},
				{
					Sid: 'S3Read',
					Effect: 'Allow',
					Action: ['s3:GetObject', 's3:ListBucket'],
					Resource: ['arn:aws:s3:::data-lake', 'arn:aws:s3:::data-lake/*'],
				},
				{
					Sid: 'CloudWatch',
					Effect: 'Allow',
					Action: ['logs:PutLogEvents', 'logs:CreateLogStream'],
					Resource: '*',
				},
			],
		};
		const result = convertAwsPolicy(awsPolicy);
		expect(result.policy.statements).toHaveLength(1);
		expect(result.policy.statements[0].actions).toEqual(['s3:GetObject', 's3:ListBucket']);
		expect(result.skipped).toHaveLength(2); // AssumeRole + CloudWatch
	});
});

// ─── convertResources ───────────────────────────────────────────────────────

describe('convertResources', () => {
	it('returns empty for wildcard *', () => {
		const warnings: string[] = [];
		expect(convertResources(['*'], warnings)).toEqual([]);
		expect(warnings).toHaveLength(0);
	});

	it('converts bucket-only ARN', () => {
		const warnings: string[] = [];
		const result = convertResources(['arn:aws:s3:::my-bucket'], warnings);
		expect(result).toEqual(['bucket:my-bucket']);
		expect(warnings).toHaveLength(0);
	});

	it('converts bucket+key ARN', () => {
		const warnings: string[] = [];
		const result = convertResources(['arn:aws:s3:::my-bucket/*'], warnings);
		expect(result).toEqual(['object:my-bucket/*']);
	});

	it('converts bucket+specific key ARN', () => {
		const warnings: string[] = [];
		const result = convertResources(['arn:aws:s3:::my-bucket/path/to/prefix*'], warnings);
		expect(result).toEqual(['object:my-bucket/path/to/prefix*']);
	});

	it('handles wildcard bucket ARN with warning', () => {
		const warnings: string[] = [];
		const result = convertResources(['arn:aws:s3:::*'], warnings);
		expect(result).toContain('bucket:*');
		expect(result).toContain('object:*/*');
		expect(warnings.some((w) => w.includes('Wildcard bucket'))).toBe(true);
	});

	it('handles wildcard bucket in object ARN with warning', () => {
		const warnings: string[] = [];
		const result = convertResources(['arn:aws:s3:::*/*'], warnings);
		expect(result).toEqual(['object:*/*']);
		expect(warnings.some((w) => w.includes('Wildcard bucket in object'))).toBe(true);
	});

	it('warns on unrecognized resource format', () => {
		const warnings: string[] = [];
		const result = convertResources(['arn:aws:iam::123456789012:role/Foo'], warnings);
		expect(result).toEqual([]);
		expect(warnings.some((w) => w.includes('Unrecognized resource format'))).toBe(true);
	});

	it('handles multiple resources', () => {
		const warnings: string[] = [];
		const result = convertResources(['arn:aws:s3:::bucket-a', 'arn:aws:s3:::bucket-a/*', 'arn:aws:s3:::bucket-b/logs/*'], warnings);
		expect(result).toEqual(['bucket:bucket-a', 'object:bucket-a/*', 'object:bucket-b/logs/*']);
	});

	it('returns empty immediately when * is in the resource list', () => {
		const warnings: string[] = [];
		// If * appears anywhere, the whole resource list maps to wildcard
		const result = convertResources(['*', 'arn:aws:s3:::my-bucket'], warnings);
		expect(result).toEqual([]);
	});

	it('passes sid through to warnings', () => {
		const warnings: string[] = [];
		convertResources(['arn:aws:s3:::data-*'], warnings, 'ReadData');
		expect(warnings[0]).toContain('ReadData');
	});

	it('strips trailing wildcard from bucket-only name', () => {
		const warnings: string[] = [];
		// arn:aws:s3:::my-bucket* (wildcard at end of bucket name, no slash)
		const result = convertResources(['arn:aws:s3:::prod-*'], warnings);
		expect(result).toContain('bucket:prod-*');
		expect(result).toContain('object:prod-*/*');
	});
});
