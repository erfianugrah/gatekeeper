import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../src/policy-engine';
import { makePolicy, allowStmt, denyStmt, makeCtx } from './policy-helpers';

// --- Action matching ---

describe('action matching', () => {
	const policy = makePolicy(allowStmt(['purge:url', 'purge:host'], ['zone:*']));

	it('exact action match -> allowed', () => {
		expect(evaluatePolicy(policy, [makeCtx('purge:url', 'zone:abc')])).toBe(true);
	});

	it('action not in list -> denied', () => {
		expect(evaluatePolicy(policy, [makeCtx('purge:tag', 'zone:abc')])).toBe(false);
	});

	it('wildcard action purge:* matches all purge actions', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*']));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc')])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:abc')])).toBe(true);
	});

	it('universal wildcard * matches any action', () => {
		const p = makePolicy(allowStmt(['*'], ['*']));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc')])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('r2:GetObject', 'bucket:foo')])).toBe(true);
	});

	it('partial wildcard does not match unrelated namespace', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*']));
		expect(evaluatePolicy(p, [makeCtx('r2:GetObject', 'zone:abc')])).toBe(false);
	});
});

// --- Resource matching ---

describe('resource matching', () => {
	it('exact resource match', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:abc123']));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc123')])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:other')])).toBe(false);
	});

	it('zone:* matches any zone', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*']));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc')])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:xyz')])).toBe(true);
	});

	it('prefix wildcard: bucket:prod-* matches bucket:prod-images', () => {
		const p = makePolicy(allowStmt(['r2:*'], ['bucket:prod-*']));
		expect(evaluatePolicy(p, [makeCtx('r2:GetObject', 'bucket:prod-images')])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('r2:GetObject', 'bucket:staging-images')])).toBe(false);
	});
});

// --- Leaf conditions ---

describe('leaf conditions', () => {
	describe('eq / ne', () => {
		it('eq string match', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'example.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'example.com' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'other.com' })])).toBe(false);
		});

		it('eq boolean match', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'purge_everything', operator: 'eq', value: true }]));
			expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:a', { purge_everything: true })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:everything', 'zone:a', { purge_everything: false })])).toBe(false);
		});

		it('ne string', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'ne', value: 'internal.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'public.com' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'internal.com' })])).toBe(false);
		});
	});

	describe('contains / not_contains', () => {
		it('contains substring', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'url', operator: 'contains', value: '/api/' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { url: 'https://example.com/api/v1' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { url: 'https://example.com/blog/' })])).toBe(false);
		});

		it('not_contains excludes substring', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'url', operator: 'not_contains', value: '/internal/' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { url: 'https://example.com/api/' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { url: 'https://example.com/internal/data' })])).toBe(false);
		});
	});

	describe('starts_with / ends_with', () => {
		it('starts_with prefix', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*'], [{ field: 'url', operator: 'starts_with', value: 'https://cdn.example.com/' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { url: 'https://cdn.example.com/img/1.png' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { url: 'https://other.com/' })])).toBe(false);
		});

		it('ends_with suffix', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'ends_with', value: '.example.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'cdn.example.com' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'example.com' })])).toBe(false);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'evil.com' })])).toBe(false);
		});
	});

	describe('matches / not_matches (regex)', () => {
		it('matches regex pattern', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*'], [{ field: 'tag', operator: 'matches', value: '^release-v[0-9]+\\.[0-9]+$' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'release-v1.0' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'release-v12.34' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'dev-build' })])).toBe(false);
		});

		it('not_matches regex exclusion', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'tag', operator: 'not_matches', value: '^internal-' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'public-v1' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'internal-secret' })])).toBe(false);
		});

		it('invalid regex fails gracefully', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'tag', operator: 'matches', value: '[invalid' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'anything' })])).toBe(false);
		});
	});

	describe('in / not_in', () => {
		it('in set match', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'in', value: ['a.com', 'b.com', 'c.com'] }]));
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'b.com' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'd.com' })])).toBe(false);
		});

		it('not_in set exclusion', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'not_in', value: ['blocked.com'] }]));
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'allowed.com' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'blocked.com' })])).toBe(false);
		});
	});

	describe('wildcard', () => {
		it('glob * matches any substring', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'wildcard', value: '*.example.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'cdn.example.com' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'sub.cdn.example.com' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'evil.com' })])).toBe(false);
		});

		it('wildcard is case-insensitive', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'wildcard', value: '*.Example.COM' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'cdn.example.com' })])).toBe(true);
		});
	});

	describe('exists / not_exists', () => {
		it('exists true when field present', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'header.CF-Device-Type', operator: 'exists', value: '' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'header.CF-Device-Type': 'mobile' })])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(false);
		});

		it('not_exists true when field absent', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'header.Origin', operator: 'not_exists', value: '' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { 'header.Origin': 'https://foo.com' })])).toBe(false);
		});
	});

	describe('missing field handling (effect-aware skip)', () => {
		// --- Allow + missing field: inapplicable conditions are vacuously satisfied ---

		it('allow + eq + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'example.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + ne + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'ne', value: 'evil.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + contains + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'contains', value: 'example' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + not_contains + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'not_contains', value: 'staging' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + starts_with + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'url', operator: 'starts_with', value: 'https://' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + in + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'in', value: ['a.com', 'b.com'] }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + not_in + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'not_in', value: ['blocked.com'] }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + wildcard + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'wildcard', value: '*.example.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + matches + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'tag', operator: 'matches', value: '^release-' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
		});

		it('allow + gt + field missing -> true (skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gt', value: '8' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
		});

		// --- Allow + exists/not_exists: NOT skipped (these explicitly test presence) ---

		it('allow + exists + field missing -> false (NOT skipped)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'header.X-Custom', operator: 'exists', value: '' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(false);
		});

		it('allow + not_exists + field missing -> true (unchanged)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'header.X-Custom', operator: 'not_exists', value: '' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
		});

		// --- Deny + missing field: condition fails, deny does NOT fire ---

		it('deny + eq + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'evil.com' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('deny + contains + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'contains', value: 'evil' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('deny + gt + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'time.hour', operator: 'gt', value: '22' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
		});

		it('deny + matches + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'tag', operator: 'matches', value: '^internal-' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
		});

		it('deny + exists + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'header.X-Evil', operator: 'exists', value: '' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(true);
		});

		// --- Mixed AND conditions: one applicable, one inapplicable ---

		it('allow + AND: inapplicable field skipped, applicable field still evaluated', () => {
			const p = makePolicy(
				allowStmt(
					['purge:*'],
					['zone:*'],
					[
						{ field: 'host', operator: 'contains', value: 'example.com' },
						{ field: 'client_ip', operator: 'eq', value: '1.2.3.4' },
					],
				),
			);
			// Tag purge: host missing (skipped), client_ip matches -> allowed
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { client_ip: '1.2.3.4' })])).toBe(true);
			// Tag purge: host missing (skipped), client_ip wrong -> denied
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { client_ip: '5.6.7.8' })])).toBe(false);
		});

		// --- Compound conditions with missing fields ---

		it('allow + any(OR) + all children have missing fields -> true (all skipped)', () => {
			const p = makePolicy(
				allowStmt(
					['purge:*'],
					['zone:*'],
					[
						{
							any: [
								{ field: 'host', operator: 'eq', value: 'a.com' },
								{ field: 'url', operator: 'contains', value: '/api/' },
							],
						},
					],
				),
			);
			// Tag purge: both host and url missing -> both skipped -> any([true, true]) -> true
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('allow + all(AND) + one child has missing field -> true (missing child skipped)', () => {
			const p = makePolicy(
				allowStmt(
					['purge:*'],
					['zone:*'],
					[
						{
							all: [
								{ field: 'host', operator: 'eq', value: 'example.com' },
								{ field: 'client_ip', operator: 'eq', value: '1.2.3.4' },
							],
						},
					],
				),
			);
			// Tag purge: host missing (skipped=true), client_ip matches -> all([true, true]) -> true
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { client_ip: '1.2.3.4' })])).toBe(true);
			// Tag purge: host missing (skipped=true), client_ip wrong -> all([true, false]) -> false
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { client_ip: '9.9.9.9' })])).toBe(false);
		});

		it('allow + not compound + missing field -> false (known edge case)', () => {
			// NOT inverts the vacuously-true result: not(true) = false
			// This is a known limitation — recommend deny effect for exclusions
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ not: { field: 'host', operator: 'eq', value: 'evil.com' } }]));
			// Tag purge: host missing -> leaf returns true (skipped) -> not(true) = false -> denied
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(false);
			// URL purge with good host: host=good.com, eq evil.com = false -> not(false) = true -> allowed
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'good.com' })])).toBe(true);
			// URL purge with evil host: host=evil.com, eq evil.com = true -> not(true) = false -> denied
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'evil.com' })])).toBe(false);
		});

		it('deny + not compound + missing field -> deny fires (not inverts false to true)', () => {
			// deny + not(eq) + missing field: skipMissing=false -> leaf returns false -> not(false) = true -> deny fires
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ not: { field: 'host', operator: 'eq', value: 'good.com' } }]),
			);
			// URL purge with good.com: eq good.com = true -> not(true) = false -> deny doesn't fire -> allowed
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'good.com' })])).toBe(true);
			// URL purge with evil.com: eq good.com = false -> not(false) = true -> deny fires -> denied
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'evil.com' })])).toBe(false);
			// Tag purge: host missing -> skipMissing=false -> leaf returns false -> not(false) = true -> deny fires
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(false);
		});

		it('allow + any(OR) + mixed: one child missing, one child present-but-non-matching -> true', () => {
			const p = makePolicy(
				allowStmt(
					['purge:*'],
					['zone:*'],
					[
						{
							any: [
								{ field: 'host', operator: 'eq', value: 'a.com' },
								{ field: 'tag', operator: 'eq', value: 'release-v1' },
							],
						},
					],
				),
			);
			// host missing (skipped -> true), tag present but wrong -> any([true, false]) -> true
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'dev-build' })])).toBe(true);
			// host present but wrong, tag present and matches -> any([false, true]) -> true
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { host: 'b.com', tag: 'release-v1' })])).toBe(true);
			// host present but wrong, tag present and wrong -> any([false, false]) -> false
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { host: 'b.com', tag: 'dev-build' })])).toBe(false);
		});

		it('multiple contexts: missing field skipped independently per context', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'example.com' }]));
			// Context 1: host present and matches -> allowed
			// Context 2: host missing -> skipped -> allowed
			// Both must individually pass -> overall allowed
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'example.com' }), makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
			// Context 1: host present but wrong -> denied
			// Overall denied (one context failed)
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'other.com' }), makeCtx('purge:tag', 'zone:a', {})])).toBe(false);
		});

		// --- Deny + missing field: remaining operators for completeness ---

		it('deny + ends_with + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'ends_with', value: '.evil.com' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('deny + wildcard + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'wildcard', value: '*.evil.*' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('deny + not_contains + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'not_contains', value: 'trusted' }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		it('deny + in + field missing -> deny does not fire', () => {
			const p = makePolicy(
				allowStmt(['purge:*'], ['zone:*']),
				denyStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'in', value: ['a.com', 'b.com'] }]),
			);
			expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', {})])).toBe(true);
		});

		// --- Field is present: behavior unchanged (sanity checks) ---

		it('allow + eq + field present and matches -> true (unchanged)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'example.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'example.com' })])).toBe(true);
		});

		it('allow + eq + field present and does not match -> false (unchanged)', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'host', operator: 'eq', value: 'example.com' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'other.com' })])).toBe(false);
		});
	});
});

// --- Compound conditions ---

describe('compound conditions', () => {
	it('any: OR logic — any child match = pass', () => {
		const p = makePolicy(
			allowStmt(
				['purge:*'],
				['zone:*'],
				[
					{
						any: [
							{ field: 'host', operator: 'eq', value: 'a.com' },
							{ field: 'host', operator: 'eq', value: 'b.com' },
						],
					},
				],
			),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'a.com' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'b.com' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:a', { host: 'c.com' })])).toBe(false);
	});

	it('all: AND logic — all children must match', () => {
		const p = makePolicy(
			allowStmt(
				['purge:*'],
				['zone:*'],
				[
					{
						all: [
							{ field: 'host', operator: 'eq', value: 'example.com' },
							{ field: 'url.path', operator: 'starts_with', value: '/blog/' },
						],
					},
				],
			),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'example.com', 'url.path': '/blog/post-1' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'example.com', 'url.path': '/api/v1' })])).toBe(false);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'other.com', 'url.path': '/blog/post-1' })])).toBe(false);
	});

	it('not: negation of a condition', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ not: { field: 'tag', operator: 'eq', value: 'internal' } }]));
		expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'public' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:a', { tag: 'internal' })])).toBe(false);
	});

	it('nested compound: any inside all', () => {
		const p = makePolicy(
			allowStmt(
				['purge:*'],
				['zone:*'],
				[
					{
						all: [
							{
								any: [
									{ field: 'host', operator: 'eq', value: 'a.com' },
									{ field: 'host', operator: 'eq', value: 'b.com' },
								],
							},
							{ field: 'url.path', operator: 'starts_with', value: '/public/' },
						],
					},
				],
			),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'a.com', 'url.path': '/public/img.png' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'b.com', 'url.path': '/public/img.png' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'c.com', 'url.path': '/public/img.png' })])).toBe(false);
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', { host: 'a.com', 'url.path': '/private/secret' })])).toBe(false);
	});
});

// --- Multiple statements (OR) ---

describe('multiple statements', () => {
	it('any statement match = allowed', () => {
		const p = makePolicy(
			allowStmt(['purge:host'], ['zone:abc'], [{ field: 'host', operator: 'eq', value: 'cdn.example.com' }]),
			allowStmt(['purge:tag'], ['zone:abc'], [{ field: 'tag', operator: 'starts_with', value: 'release-' }]),
		);
		expect(evaluatePolicy(p, [makeCtx('purge:host', 'zone:abc', { host: 'cdn.example.com' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:abc', { tag: 'release-v1' })])).toBe(true);
		expect(evaluatePolicy(p, [makeCtx('purge:tag', 'zone:abc', { tag: 'dev-build' })])).toBe(false);
	});
});

// --- Multiple contexts (ALL must pass) ---

describe('multiple request contexts', () => {
	it('all contexts must be allowed', () => {
		const p = makePolicy(allowStmt(['purge:url'], ['zone:*'], [{ field: 'host', operator: 'ends_with', value: '.example.com' }]));
		const allowed = makeCtx('purge:url', 'zone:a', { host: 'cdn.example.com' });
		const denied = makeCtx('purge:url', 'zone:a', { host: 'evil.com' });

		expect(evaluatePolicy(p, [allowed])).toBe(true);
		expect(evaluatePolicy(p, [denied])).toBe(false);
		expect(evaluatePolicy(p, [allowed, denied])).toBe(false);
	});

	it('empty contexts array -> allowed (nothing to deny)', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:*']));
		expect(evaluatePolicy(p, [])).toBe(true);
	});
});

// --- No statements = deny all ---

describe('empty policy', () => {
	it('policy with no statements denies everything', () => {
		const p = makePolicy();
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a')])).toBe(false);
	});
});

// --- No conditions = no restrictions ---

describe('statement without conditions', () => {
	it('no conditions means action+resource match is sufficient', () => {
		const p = makePolicy(allowStmt(['purge:*'], ['zone:abc']));
		expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:abc', { host: 'anything.com', url: 'https://whatever/' })])).toBe(true);
	});
});
