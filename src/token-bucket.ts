import type { ConsumeResult } from "./types";

export class TokenBucket {
	private tokens: number;
	private lastRefill: number;
	readonly rate: number;
	readonly bucketSize: number;

	constructor(rate: number, bucketSize: number) {
		this.rate = rate;
		this.bucketSize = bucketSize;
		this.tokens = bucketSize; // start full
		this.lastRefill = Date.now();
	}

	/**
	 * Attempt to consume `count` tokens.
	 * Returns whether the request is allowed, remaining tokens, and retry-after seconds.
	 */
	consume(count: number): ConsumeResult {
		this.refill();

		if (count <= 0) {
			return { allowed: true, remaining: Math.floor(this.tokens), retryAfterSec: 0 };
		}

		if (this.tokens >= count) {
			this.tokens -= count;
			return {
				allowed: true,
				remaining: Math.floor(this.tokens),
				retryAfterSec: 0,
			};
		}

		const deficit = count - this.tokens;
		const retryAfterSec = Math.ceil(deficit / this.rate);
		return {
			allowed: false,
			remaining: 0,
			retryAfterSec,
		};
	}

	/** Drain bucket to 0 (used when upstream returns 429). */
	drain(): void {
		this.tokens = 0;
		this.lastRefill = Date.now();
	}

	/** Get current remaining tokens (after refill). */
	getRemaining(): number {
		this.refill();
		return Math.floor(this.tokens);
	}

	/** Seconds until one full token is available (0 if tokens > 0). */
	getSecondsUntilRefill(): number {
		this.refill();
		if (this.tokens >= 1) return 0;
		return Math.ceil((1 - this.tokens) / this.rate);
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = (now - this.lastRefill) / 1000;
		if (elapsed <= 0) return; // clock skew protection
		this.tokens = Math.min(this.bucketSize, this.tokens + elapsed * this.rate);
		this.lastRefill = now;
	}
}
