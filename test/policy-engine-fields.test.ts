import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../src/policy-engine';
import { makePolicy, allowStmt, denyStmt, makeCtx } from './policy-helpers';

describe('IP/geo/time condition fields', () => {
	it('client_ip exact match', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'client_ip', operator: 'eq', value: '203.0.113.42' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '203.0.113.42' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '198.51.100.1' })])).toBe(false);
	});

	it('client_ip in allowed CIDR-like set', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*'], [{ field: 'client_ip', operator: 'in', value: ['203.0.113.42', '198.51.100.1', '10.0.0.1'] }]),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '198.51.100.1' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '172.16.0.1' })])).toBe(false);
	});

	it('client_country restriction', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'client_country', operator: 'in', value: ['US', 'DE', 'SG'] }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_country: 'US' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_country: 'RU' })])).toBe(false);
	});

	it('deny from specific country', () => {
		const p = makePolicy(
			allowStmt(['purge:*'], ['zone:*']),
			denyStmt(['purge:*'], ['zone:*'], [{ field: 'client_country', operator: 'eq', value: 'CN' }]),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_country: 'US' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_country: 'CN' })])).toBe(false);
	});

	it('client_asn numeric comparison', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'client_asn', operator: 'eq', value: '13335' }]));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_asn: '13335' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_asn: '15169' })])).toBe(false);
	});

	it('time.day_of_week restriction (weekdays only: 1-5)', () => {
		const p = makePolicy(
			allowStmt(
				['purge:*'],
				['zone:*'],
				[
					{ field: 'time.day_of_week', operator: 'gte', value: '1' },
					{ field: 'time.day_of_week', operator: 'lte', value: '5' },
				],
			),
		);
		// Wednesday
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.day_of_week': '3' })])).toBe(true);
		// Sunday
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.day_of_week': '0' })])).toBe(false);
		// Saturday
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'time.day_of_week': '6' })])).toBe(false);
	});

	it('combined: IP allowlist + business hours + weekdays', () => {
		const p = makePolicy(
			allowStmt(
				['purge:*'],
				['zone:*'],
				[
					{ field: 'client_ip', operator: 'in', value: ['10.0.0.1', '10.0.0.2'] },
					{ field: 'time.hour', operator: 'gte', value: '9' },
					{ field: 'time.hour', operator: 'lt', value: '17' },
					{ field: 'time.day_of_week', operator: 'gte', value: '1' },
					{ field: 'time.day_of_week', operator: 'lte', value: '5' },
				],
			),
		);
		// Correct IP, business hours, weekday
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '10.0.0.1', 'time.hour': '12', 'time.day_of_week': '2' })])).toBe(
			true,
		);
		// Wrong IP
		expect(
			evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '192.168.1.1', 'time.hour': '12', 'time.day_of_week': '2' })]),
		).toBe(false);
		// After hours
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '10.0.0.1', 'time.hour': '20', 'time.day_of_week': '2' })])).toBe(
			false,
		);
		// Weekend
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { client_ip: '10.0.0.1', 'time.hour': '12', 'time.day_of_week': '0' })])).toBe(
			false,
		);
	});
});
