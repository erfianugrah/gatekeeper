import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenBucket } from "../src/token-bucket";

describe("TokenBucket", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("consume within capacity → allowed", () => {
		const bucket = new TokenBucket(10, 100); // 10/s, 100 max
		const result = bucket.consume(5);
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(95);
		expect(result.retryAfterSec).toBe(0);
	});

	it("consume exactly at capacity → allowed, remaining = 0", () => {
		const bucket = new TokenBucket(10, 100);
		const result = bucket.consume(100);
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(0);
		expect(result.retryAfterSec).toBe(0);
	});

	it("consume over capacity → denied, correct retryAfter", () => {
		const bucket = new TokenBucket(10, 100);
		// Drain first
		bucket.consume(100);
		const result = bucket.consume(5);
		expect(result.allowed).toBe(false);
		expect(result.remaining).toBe(0);
		// deficit = 5, rate = 10/s → retryAfter = ceil(5/10) = 1
		expect(result.retryAfterSec).toBe(1);
	});

	it("retryAfter reflects actual deficit", () => {
		const bucket = new TokenBucket(10, 100);
		bucket.consume(100); // drain
		// Try to consume 25 tokens with 0 remaining → deficit = 25, rate = 10 → ceil(25/10) = 3
		const result = bucket.consume(25);
		expect(result.allowed).toBe(false);
		expect(result.retryAfterSec).toBe(3);
	});

	it("refill after elapsed time → correct token count", () => {
		const bucket = new TokenBucket(10, 100);
		bucket.consume(50); // 50 remaining

		// Advance 3 seconds → refill = 3 * 10 = 30 tokens → 50 + 30 = 80
		vi.advanceTimersByTime(3000);

		const result = bucket.consume(0);
		expect(result.remaining).toBe(80);
	});

	it("refill does not exceed bucket size", () => {
		const bucket = new TokenBucket(10, 100);
		bucket.consume(10); // 90 remaining

		// Advance 20 seconds → would add 200 tokens, but capped at 100
		vi.advanceTimersByTime(20000);

		expect(bucket.getRemaining()).toBe(100);
	});

	it("burst: empty bucket, wait, burst up to bucket size", () => {
		const bucket = new TokenBucket(50, 500);
		bucket.consume(500); // drain to 0
		expect(bucket.getRemaining()).toBe(0);

		// Wait 10 seconds → refill = 10 * 50 = 500 → back to full
		vi.advanceTimersByTime(10000);
		expect(bucket.getRemaining()).toBe(500);

		// Burst consume all at once
		const result = bucket.consume(500);
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(0);
	});

	it("fractional tokens: no floating point drift over many operations", () => {
		// rate = 3 tokens/sec → 1 token every 333.33ms
		const bucket = new TokenBucket(3, 100);
		bucket.consume(100); // drain

		// Advance 100 iterations of 100ms each = 10 seconds total → 30 tokens
		for (let i = 0; i < 100; i++) {
			vi.advanceTimersByTime(100);
		}

		const remaining = bucket.getRemaining();
		// Should be exactly 30 (10s * 3/s)
		expect(remaining).toBe(30);
	});

	it("zero-count consume → always allowed", () => {
		const bucket = new TokenBucket(10, 100);
		bucket.consume(100); // drain
		const result = bucket.consume(0);
		expect(result.allowed).toBe(true);
		// remaining = 0 (no refill since same instant)
		expect(result.remaining).toBe(0);
		expect(result.retryAfterSec).toBe(0);
	});

	it("negative count consume → treated as zero, always allowed", () => {
		const bucket = new TokenBucket(10, 100);
		bucket.consume(50); // 50 remaining
		const result = bucket.consume(-5);
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(50);
	});

	it("negative elapsed time (clock skew) -- clamp to 0, don't add negative tokens", () => {
		const bucket = new TokenBucket(10, 100);
		bucket.consume(50); // 50 remaining

		// Move clock backwards by 5 seconds using setSystemTime
		const now = Date.now();
		vi.setSystemTime(new Date(now - 5000));

		// Should still have 50 tokens — no negative refill
		expect(bucket.getRemaining()).toBe(50);
	});

	describe("drain()", () => {
		it("sets tokens to 0", () => {
			const bucket = new TokenBucket(10, 100);
			expect(bucket.getRemaining()).toBe(100);
			bucket.drain();
			expect(bucket.getRemaining()).toBe(0);
		});

		it("drained bucket refills over time", () => {
			const bucket = new TokenBucket(10, 100);
			bucket.drain();
			expect(bucket.getRemaining()).toBe(0);

			vi.advanceTimersByTime(5000); // 5s * 10/s = 50
			expect(bucket.getRemaining()).toBe(50);
		});
	});

	describe("getSecondsUntilRefill()", () => {
		it("returns 0 when tokens available", () => {
			const bucket = new TokenBucket(10, 100);
			expect(bucket.getSecondsUntilRefill()).toBe(0);
		});

		it("returns correct seconds when empty", () => {
			const bucket = new TokenBucket(10, 100);
			bucket.drain();
			// Need 1 token, rate = 10/s → ceil(1/10) = 1s
			expect(bucket.getSecondsUntilRefill()).toBe(1);
		});

		it("returns correct seconds when fractionally empty", () => {
			const bucket = new TokenBucket(10, 100);
			bucket.consume(100); // drain to 0

			// Advance 50ms → 0.5 tokens. Need 0.5 more for 1 full token
			vi.advanceTimersByTime(50);
			// (1 - 0.5) / 10 = 0.05 → ceil = 1
			expect(bucket.getSecondsUntilRefill()).toBe(1);
		});
	});
});
