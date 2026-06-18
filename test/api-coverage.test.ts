import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../scripts/api-coverage/registry';
import { opKey } from '../scripts/api-coverage/types';

/**
 * Hermetic API-coverage invariant.
 *
 * This NEVER touches the network. It reads each provider's committed snapshot (the baseline
 * captured by `scripts/api-coverage/refresh.ts`) and re-runs every op through the proxy's own
 * classifier. It guarantees, offline and on every `npm test`:
 *
 *   1. No silent coverage gap — every snapshot op is either classified by the proxy OR
 *      consciously listed in the provider allowlist with a reason.
 *   2. Snapshot freshness vs the classifier — the committed `covered` flag matches what the
 *      classifier returns now, so changing the classifier forces a snapshot regen.
 *   3. Allowlist hygiene — every allowlist entry corresponds to a real, still-uncovered op
 *      (no stale entries, none silently covered).
 *
 * Drift vs the LIVE upstream spec is a separate concern, owned by `refresh.ts --check` (which
 * does hit the network). Run that on a schedule; this test keeps the committed baseline honest.
 */
describe('api coverage', () => {
	for (const provider of PROVIDERS) {
		describe(provider.label, () => {
			it('has a non-empty committed snapshot', () => {
				expect(provider.snapshot.length).toBeGreaterThan(0);
			});

			it('classifies every snapshot op or consciously allowlists it', () => {
				const uncovered = provider.snapshot.filter((op) => !provider.isCovered(op) && !(opKey(op) in provider.allowlist));
				expect(uncovered.map(opKey)).toEqual([]);
			});

			it('keeps the committed coverage flag in sync with the classifier', () => {
				const drifted = provider.snapshot.filter((op) => op.covered !== provider.isCovered(op)).map(opKey);
				expect(drifted).toEqual([]);
			});

			it('has no allowlist entry that the classifier actually covers', () => {
				const nowCovered = Object.keys(provider.allowlist).filter((key) => {
					const op = provider.snapshot.find((o) => opKey(o) === key);
					return op ? provider.isCovered(op) : false;
				});
				expect(nowCovered).toEqual([]);
			});

			it('has no allowlist entry that is missing from the snapshot', () => {
				const snapshotKeys = new Set(provider.snapshot.map(opKey));
				const orphaned = Object.keys(provider.allowlist).filter((key) => !snapshotKeys.has(key));
				expect(orphaned).toEqual([]);
			});
		});
	}
});
