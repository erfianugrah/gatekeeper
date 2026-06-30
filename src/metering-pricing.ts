/**
 * Illustrative per-surface pricing for the metering rollups.
 *
 * These rates are MADE-UP placeholders, not real list prices - they exist to turn
 * the raw per-tenant usage counts (already collected from real traffic) into a
 * billable cost figure so the metering surface shows something meaningful. Tune
 * `METERING_PRICING` freely; the keys MUST stay in lockstep with the metering
 * descriptor registry in `analytics-metering.ts` (one entry per event table).
 *
 * Pure module - no D1, no `cloudflare:*` imports - so `computeCostUsd` is unit-tested
 * directly and can be applied server-side at query time across UI + CLI consistently.
 */

export interface SurfaceRate {
	/** USD per read request. */
	read: number;
	/** USD per write request. */
	write: number;
	/** USD per GiB of egress (0 when the surface does not bill egress). */
	egressPerGiB: number;
}

/** USD rates per event table. Surfaces with no read/write split use `read` as the flat per-request rate. */
export const METERING_PRICING: Record<string, SurfaceRate> = {
	purge_events: { read: 0.000015, write: 0.000015, egressPerGiB: 0 },
	dns_events: { read: 0.000002, write: 0.00001, egressPerGiB: 0 },
	cf_proxy_events: { read: 0.000005, write: 0.00002, egressPerGiB: 0.09 },
	supabase_proxy_events: { read: 0.00001, write: 0.00005, egressPerGiB: 0.09 },
	s3_events: { read: 0.0000004, write: 0.000005, egressPerGiB: 0.09 },
};

const BYTES_PER_GIB = 1024 ** 3;

export interface CostInputs {
	total_requests: number;
	read_requests: number | null;
	write_requests: number | null;
	egress_bytes: number | null;
}

/** Round to micro-dollar precision so summed costs stay stable. */
function roundUsd(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

/**
 * Billable cost (USD) for one metering group from its usage counts.
 * - Surfaces with a read/write split bill reads and writes at their own rates.
 * - Surfaces without a split (`read_requests`/`write_requests` null) bill every
 *   request at the flat `read` rate.
 * - Egress is added only when the surface bills it and `egress_bytes` is present.
 * - Unknown tables return 0 (fail-safe - never invent a charge for an unmapped surface).
 */
export function computeCostUsd(table: string, usage: CostInputs): number {
	const rate = METERING_PRICING[table];
	if (!rate) return 0;
	const requestCost =
		usage.read_requests !== null && usage.write_requests !== null
			? usage.read_requests * rate.read + usage.write_requests * rate.write
			: usage.total_requests * rate.read;
	const egressCost = rate.egressPerGiB > 0 && usage.egress_bytes ? (usage.egress_bytes / BYTES_PER_GIB) * rate.egressPerGiB : 0;
	return roundUsd(requestCost + egressCost);
}
