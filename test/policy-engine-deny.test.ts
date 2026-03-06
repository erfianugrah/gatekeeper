import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../src/policy-engine';
import { makePolicy, allowStmt, denyStmt, makeCtx } from './policy-helpers';

describe('deny statements', () => {
	it('explicit deny overrides allow for same action+resource', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*']), denyStmt(['purge:everything'], ['zone:*']));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc')])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:abc')])).toBe(false);
	});

	it('deny first: deny before allow in statement order still denies', () => {
		const p = makePolicy(denyStmt(['purge:everything'], ['zone:*']), allowStmt(['purge:*'], ['zone:*']));
		expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:abc')])).toBe(false);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc')])).toBe(true);
	});

	it('deny with conditions: deny specific host', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*']),
			denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'internal.example.com' }]),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'public.example.com' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'internal.example.com' })])).toBe(false);
	});

	it('deny-only policy: everything is denied (no allow statements)', () => {
		const p = makePolicy(denyStmt(['purge:*'], ['zone:*']));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc')])).toBe(false);
	});

	it('deny does not match -> implicit deny still applies if no allow matches', () => {
		const p = makePolicy(denyStmt(['purge:everything'], ['zone:*']));
		// purge:url doesn't match the deny, but there's no allow either -> implicit deny
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc')])).toBe(false);
	});

	it('deny with wildcard conditions blocks matching requests', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*']),
			denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'wildcard', value: '*.internal.*' }]),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'cdn.internal.corp' })])).toBe(false);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'cdn.public.com' })])).toBe(true);
	});

	it('deny with numeric condition: block off-hours', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*']),
			denyStmt(['purge:everything'], ['zone:*'], [{ field: 'time.hour', operator: 'gte', value: '22' }]),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:a', { 'time.hour': '14' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:a', { 'time.hour': '23' })])).toBe(false);
	});

	it('multiple contexts: deny on any context -> entire request denied', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*']),
			denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'blocked.com' }]),
		);
		const allowed = makeCtx('purge:host', 'zone:a', { host: 'ok.com' });
		const denied = makeCtx('purge:host', 'zone:a', { host: 'blocked.com' });
		expect(evaluatePolicy(p, [allowed])).toBe(true);
		expect(evaluatePolicy(p, [denied])).toBe(false);
		expect(evaluatePolicy(p, [allowed, denied])).toBe(false);
	});

	it('deny with compound condition (all)', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*']),
			denyStmt(
				['purge:*'],
				['zone:*'],
				[
					{
						all: [
							{ field: 'host', operator: 'eq', value: 'staging.example.com' },
							{ field: 'purge_everything', operator: 'eq', value: true },
						],
					},
				],
			),
		);
		// Both conditions match -> denied
		expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:a', { host: 'staging.example.com', purge_everything: true })])).toBe(false);
		// Only one matches -> allow (deny doesn't match)
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'staging.example.com', purge_everything: false })])).toBe(true);
		// Neither matches -> allow
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'prod.example.com' })])).toBe(true);
	});
});
