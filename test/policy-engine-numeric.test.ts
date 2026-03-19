import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../src/policy-engine';
import { makePolicy, allowStmt, denyStmt, makeCtx } from './policy-helpers';

describe('numeric operators', () => {
	it('lt: field < value -> allowed', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'lt', value: '18' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '10' })])).toBe(true);
	});

	it('lt: field == value -> denied', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'lt', value: '18' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '18' })])).toBe(false);
	});

	it('lt: field > value -> denied', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'lt', value: '18' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '22' })])).toBe(false);
	});

	it('gt: field > value -> allowed', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gt', value: '8' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '14' })])).toBe(true);
	});

	it('gt: field == value -> denied', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gt', value: '8' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '8' })])).toBe(false);
	});

	it('lte: field <= value -> allowed', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'lte', value: '18' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '18' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '10' })])).toBe(true);
	});

	it('lte: field > value -> denied', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'lte', value: '18' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '19' })])).toBe(false);
	});

	it('gte: field >= value -> allowed', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gte', value: '8' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '8' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '14' })])).toBe(true);
	});

	it('gte: field < value -> denied', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gte', value: '8' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '5' })])).toBe(false);
	});

	it('NaN field value -> denied (safe default)', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'lt', value: '18' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': 'not-a-number' })])).toBe(false);
	});

	it('NaN condition value -> denied (safe default)', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'lt', value: 'xyz' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '10' })])).toBe(false);
	});

	it('missing field on allow -> skipped (vacuously satisfied)', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gt', value: '0' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
	});

	it('missing field on deny -> condition fails, deny does not fire', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*']),
			denyStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gt', value: '22' }]),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
	});

	it('numeric comparison with decimals', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'score', operator: 'gte', value: '3.5' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { score: '4.2' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { score: '3.5' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { score: '2.1' })])).toBe(false);
	});

	it('boolean field coerces to number: true=1, false=0', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'flag', operator: 'gte', value: '1' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { flag: true })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { flag: false })])).toBe(false);
	});

	it('time-window: combined gte + lt for business hours', () => {
		const p = makePolicy(
			allowStmt(
				['purge:*'],
				['zone:*'],
				[
					{ field: 'time.hour', operator: 'gte', value: '9' },
					{ field: 'time.hour', operator: 'lt', value: '17' },
				],
			),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '12' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '9' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '17' })])).toBe(false);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.hour': '3' })])).toBe(false);
	});
});
