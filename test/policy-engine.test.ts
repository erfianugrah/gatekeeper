import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../src/policy-engine';
import { makePolicy, allowStmt, makeCtx } from './policy-helpers';

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

	describe('missing field handling', () => {
		it('non-exist field fails for string operators', () => {
			const p = makePolicy(allowStmt(['purge:*'], ['zone:*'], [{ field: 'nonexistent', operator: 'eq', value: 'anything' }]));
			expect(evaluatePolicy(p, [makeCtx('purge:url', 'zone:a', {})])).toBe(false);
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
