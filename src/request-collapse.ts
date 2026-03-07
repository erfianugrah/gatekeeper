/**
 * Generic request coalescing / collapsing utility.
 *
 * Deduplicates identical in-flight requests so only one upstream call is made.
 * Works at any level — V8 isolate (module-scoped) or Durable Object (instance-scoped).
 *
 * The grace window allows requests arriving shortly after the leader settles
 * to still piggyback on the cached result. Grace expiry is enforced synchronously
 * at lookup time (not via setTimeout) to avoid stale entries when timers don't
 * fire between requests — a known Cloudflare Workers runtime behaviour.
 */

import { generateFlightId } from './crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Flight<T> {
	promise: Promise<T>;
	/** Timestamp (Date.now()) when the promise settled. null while still pending. */
	settledAt: number | null;
}

export interface CollapseResult<T> {
	result: T;
	/** True if this request piggy-backed on an existing in-flight or grace-period flight. */
	collapsed: boolean;
	/** Stable identifier shared by the leader and all its followers. */
	flightId: string;
}

// ─── RequestCollapser ───────────────────────────────────────────────────────

const DEFAULT_GRACE_MS = 50;

export class RequestCollapser<T> {
	private inflight = new Map<string, { flight: Flight<T>; flightId: string }>();
	private graceMs: number;

	constructor(graceMs = DEFAULT_GRACE_MS) {
		this.graceMs = graceMs;
	}

	/**
	 * If an identical request is already in-flight (or within the grace window
	 * after settlement), return its result. Otherwise, call `createFlight` to
	 * start a new upstream call.
	 *
	 * @param key   Dedup key — typically `zoneId\0bodyText` or similar.
	 * @param createFlight  Factory that performs the actual upstream work.
	 */
	async collapseOrCreate(key: string, createFlight: () => Promise<T>): Promise<CollapseResult<T>> {
		const existing = this.inflight.get(key);

		if (existing) {
			const { flight, flightId } = existing;

			// Synchronous grace-window check — the real enforcement.
			// setTimeout is unreliable across request boundaries in Workers.
			if (flight.settledAt !== null && Date.now() - flight.settledAt > this.graceMs) {
				// Stale — expired past grace window. Clean up and fall through to create a new flight.
				console.log(JSON.stringify({ breadcrumb: 'collapse-stale-evict', flightId }));
				this.inflight.delete(key);
			} else {
				try {
					const result = await flight.promise;
					console.log(JSON.stringify({ breadcrumb: 'collapse-follower', flightId }));
					return { result, collapsed: true, flightId };
				} catch {
					// Leader failed — remove the broken entry and create a new flight below
					console.log(JSON.stringify({ breadcrumb: 'collapse-leader-failed', flightId }));
					this.inflight.delete(key);
				}
			}
		}

		// Leader path — create a new flight
		const flightId = generateFlightId();
		const flight: Flight<T> = { promise: null!, settledAt: null };
		const promise = createFlight();
		flight.promise = promise;

		this.inflight.set(key, { flight, flightId });

		promise
			.finally(() => {
				flight.settledAt = Date.now();
				// Best-effort cleanup via setTimeout — may or may not fire between requests.
				// The synchronous check above is the real guard; this just prevents memory leaks
				// when the isolate stays hot with different keys.
				setTimeout(() => {
					const current = this.inflight.get(key);
					if (current && current.flight === flight) {
						this.inflight.delete(key);
					}
				}, this.graceMs);
			})
			.catch(() => {}); // Suppress — rejection is handled by the caller's await

		const result = await promise;
		return { result, collapsed: false, flightId };
	}

	/** Number of active entries (in-flight + grace). For diagnostics / testing. */
	get size(): number {
		return this.inflight.size;
	}

	/** Clear all entries. @internal For testing only. */
	__testClear(): void {
		this.inflight.clear();
	}
}
