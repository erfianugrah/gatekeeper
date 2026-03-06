import { describe, it, expect } from 'vitest';
import { validatePolicy } from '../src/policy-engine';

describe('validatePolicy', () => {
	it('valid policy returns no errors', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:url'],
					resources: ['zone:abc'],
					conditions: [{ field: 'host', operator: 'eq', value: 'example.com' }],
				},
			],
		});
		expect(errors).toHaveLength(0);
	});

	it('missing version', () => {
		const errors = validatePolicy({ statements: [{ effect: 'allow', actions: ['*'], resources: ['*'] }] });
		expect(errors.some((e) => e.path === 'version')).toBe(true);
	});

	it('empty statements', () => {
		const errors = validatePolicy({ version: '2025-01-01', statements: [] });
		expect(errors.some((e) => e.path === 'statements')).toBe(true);
	});

	it('invalid operator', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'host', operator: 'INVALID', value: 'x' }],
				},
			],
		});
		expect(errors.some((e) => e.path.includes('operator'))).toBe(true);
	});

	it('regex too long', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'tag', operator: 'matches', value: 'a'.repeat(300) }],
				},
			],
		});
		expect(errors.some((e) => e.message.includes('max length'))).toBe(true);
	});

	it('dangerous regex rejected', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'tag', operator: 'matches', value: '(a+)+$' }],
				},
			],
		});
		expect(errors.some((e) => e.message.includes('catastrophic'))).toBe(true);
	});

	it('invalid regex syntax', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'tag', operator: 'matches', value: '[unclosed' }],
				},
			],
		});
		expect(errors.some((e) => e.message.includes('Invalid regex'))).toBe(true);
	});

	it('in operator requires string array', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'host', operator: 'in', value: 'not-an-array' }],
				},
			],
		});
		expect(errors.some((e) => e.message.includes('non-empty string array'))).toBe(true);
	});

	it('validates compound conditions', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [
						{
							any: [
								{ field: 'host', operator: 'eq', value: 'a.com' },
								{ field: '', operator: 'eq', value: 'b.com' }, // empty field
							],
						},
					],
				},
			],
		});
		expect(errors.some((e) => e.path.includes('field'))).toBe(true);
	});

	it('null policy', () => {
		const errors = validatePolicy(null);
		expect(errors.length).toBeGreaterThan(0);
	});

	it('exists operator does not require value', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'header.CF-Device-Type', operator: 'exists' }],
				},
			],
		});
		expect(errors).toHaveLength(0);
	});

	it('deny effect is valid', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [{ effect: 'deny', actions: ['purge:everything'], resources: ['zone:*'] }],
		});
		expect(errors).toHaveLength(0);
	});

	it('invalid effect rejected', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [{ effect: 'block', actions: ['*'], resources: ['*'] }],
		});
		expect(errors.some((e) => e.path.includes('effect'))).toBe(true);
	});

	it('numeric operators (lt/gt/lte/gte) are valid with numeric string', () => {
		for (const op of ['lt', 'gt', 'lte', 'gte']) {
			const errors = validatePolicy({
				version: '2025-01-01',
				statements: [
					{
						effect: 'allow',
						actions: ['*'],
						resources: ['*'],
						conditions: [{ field: 'time.hour', operator: op, value: '18' }],
					},
				],
			});
			expect(errors).toHaveLength(0);
		}
	});

	it('numeric operators reject non-numeric string value', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'time.hour', operator: 'lt', value: 'midnight' }],
				},
			],
		});
		expect(errors.some((e) => e.message.includes('numeric string'))).toBe(true);
	});

	it('numeric operators reject non-string value type', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['*'],
					resources: ['*'],
					conditions: [{ field: 'time.hour', operator: 'gt', value: 18 }],
				},
			],
		});
		expect(errors.some((e) => e.message.includes('numeric string'))).toBe(true);
	});

	it('mixed allow+deny policy validates', () => {
		const errors = validatePolicy({
			version: '2025-01-01',
			statements: [
				{ effect: 'allow', actions: ['purge:*'], resources: ['zone:*'] },
				{
					effect: 'deny',
					actions: ['purge:everything'],
					resources: ['zone:*'],
					conditions: [{ field: 'time.hour', operator: 'gte', value: '22' }],
				},
			],
		});
		expect(errors).toHaveLength(0);
	});
});
