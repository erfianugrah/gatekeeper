import { describe, it, expect } from 'vitest';
import { computeCostUsd, METERING_PRICING } from '../src/metering-pricing';

const GIB = 1024 ** 3;

describe('computeCostUsd', () => {
	it('prices a read/write split surface (supabase) on reads + writes + egress', () => {
		// 2 reads * 0.000010 + 1 write * 0.000050 = 0.00007; egress 150 bytes is negligible at 1e-6 rounding.
		const cost = computeCostUsd('supabase_proxy_events', {
			total_requests: 3,
			read_requests: 2,
			write_requests: 1,
			egress_bytes: 150,
		});
		expect(cost).toBeCloseTo(0.00007, 6);
	});

	it('charges egress per GiB when the surface tracks it', () => {
		// 1 write s3 = 0.000005 + 1 GiB egress * 0.09 = 0.090005
		const cost = computeCostUsd('s3_events', {
			total_requests: 1,
			read_requests: 0,
			write_requests: 1,
			egress_bytes: GIB,
		});
		expect(cost).toBeCloseTo(0.090005, 6);
	});

	it('uses the read rate for surfaces with no read/write split (purge)', () => {
		// purge read==write flat rate, no split → total * rate.read = 5 * 0.000015 = 0.000075
		const cost = computeCostUsd('purge_events', {
			total_requests: 5,
			read_requests: null,
			write_requests: null,
			egress_bytes: null,
		});
		expect(cost).toBeCloseTo(0.000075, 6);
	});

	it('ignores egress when egress_bytes is null', () => {
		const cost = computeCostUsd('cf_proxy_events', {
			total_requests: 4,
			read_requests: 4,
			write_requests: 0,
			egress_bytes: null,
		});
		// 4 reads * 0.000005 = 0.00002, no egress
		expect(cost).toBeCloseTo(0.00002, 6);
	});

	it('returns 0 for an unknown table', () => {
		expect(computeCostUsd('evil_events', { total_requests: 100, read_requests: 50, write_requests: 50, egress_bytes: 999 })).toBe(0);
	});

	it('returns 0 for an empty group', () => {
		expect(computeCostUsd('dns_events', { total_requests: 0, read_requests: 0, write_requests: 0, egress_bytes: null })).toBe(0);
	});

	it('every metering descriptor table has a pricing entry', () => {
		// Keeps pricing in lockstep with the descriptor registry (see analytics-metering.ts).
		for (const table of ['purge_events', 'dns_events', 'cf_proxy_events', 'supabase_proxy_events', 's3_events']) {
			expect(METERING_PRICING[table]).toBeDefined();
		}
	});
});
