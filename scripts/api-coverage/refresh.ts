#!/usr/bin/env tsx
/**
 * API coverage drift refresh.
 *
 * For each registered provider: fetch the live upstream op set, classify each op through the
 * proxy's own classifier, and reconcile against the committed snapshot.
 *
 *   tsx scripts/api-coverage/refresh.ts            # --check (default): fail on drift, write nothing
 *   tsx scripts/api-coverage/refresh.ts --write    # rewrite the committed snapshots from live specs
 *   npm run check:api-coverage                     # = --check
 *   npm run api-coverage:write                     # = --write
 *
 * This is the "keeping up with changing upstream schemas" job. The hermetic coverage test
 * (`test/api-coverage.test.ts`) only ever reads the committed snapshot, so it runs offline and
 * never lags reality on its own. THIS script is what reaches the network: run it on a schedule
 * (or before a release) and it fails loudly when an upstream adds/moves an endpoint the proxy
 * classifier doesn't yet handle, or when a committed snapshot has gone stale.
 *
 * Must stay free of `cloudflare:workers` imports — it runs in plain tsx/Node, not the Workers pool.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROVIDERS } from './registry';
import { buildSnapshot, opKey, serializeSnapshot, type ApiOp, type SnapshotOp } from './types';

const REPO_ROOT = resolve(import.meta.dirname!, '..', '..');
const WRITE = process.argv.includes('--write');

interface ProviderResult {
	id: string;
	label: string;
	live: number;
	covered: number;
	/** Live ops neither covered nor allowlisted — genuine coverage gaps. */
	gaps: SnapshotOp[];
	/** Allowlist keys that no longer match any live op — stale entries to prune. */
	staleAllowlist: string[];
	/** Allowlist keys that the classifier now actually covers — promote out of the allowlist. */
	nowCovered: string[];
	/** True when the freshly built snapshot differs from what is committed on disk. */
	snapshotChanged: boolean;
	snapshotPath: string;
	serialized: string;
}

function diffSummary(committed: SnapshotOp[], next: SnapshotOp[]): string[] {
	const byKey = (rows: SnapshotOp[]) => new Map(rows.map((r) => [opKey(r), r] as const));
	const before = byKey(committed);
	const after = byKey(next);
	const lines: string[] = [];
	for (const [key, row] of after) {
		const prev = before.get(key);
		if (!prev) lines.push(`    + ${key}${row.covered ? '' : '  (UNCOVERED)'}`);
		else if (prev.covered !== row.covered) lines.push(`    ~ ${key}  covered ${prev.covered} -> ${row.covered}`);
	}
	for (const [key] of before) if (!after.has(key)) lines.push(`    - ${key}  (removed upstream)`);
	return lines.sort();
}

async function evaluate(): Promise<ProviderResult[]> {
	const results: ProviderResult[] = [];
	for (const provider of PROVIDERS) {
		const liveOps: ApiOp[] = await provider.fetchLiveOps();
		const next = buildSnapshot(liveOps, (op) => provider.isCovered(op));

		const liveKeys = new Set(next.map(opKey));
		const gaps = next.filter((op) => !op.covered && !(opKey(op) in provider.allowlist));
		const staleAllowlist = Object.keys(provider.allowlist).filter((k) => !liveKeys.has(k));
		const nowCovered = next.filter((op) => op.covered && opKey(op) in provider.allowlist).map(opKey);

		const serialized = serializeSnapshot(next);
		const committedPath = resolve(REPO_ROOT, provider.snapshotPath);
		let committedRaw = '[]\n';
		try {
			committedRaw = readFileSync(committedPath, 'utf-8');
		} catch {
			// missing snapshot — treated as changed below
		}

		results.push({
			id: provider.id,
			label: provider.label,
			live: next.length,
			covered: next.filter((o) => o.covered).length,
			gaps,
			staleAllowlist,
			nowCovered,
			snapshotChanged: committedRaw !== serialized,
			snapshotPath: committedPath,
			serialized,
		});
	}
	return results;
}

const results = await evaluate();
let failed = false;

for (const r of results) {
	console.log(`\n${r.label} (${r.id})`);
	console.log(
		`  live ops: ${r.live}   covered: ${r.covered}   allowlisted: ${r.live - r.covered - r.gaps.length}   gaps: ${r.gaps.length}`,
	);

	if (r.gaps.length) {
		failed = true;
		console.log('  UNCOVERED (not in allowlist — classify it or allowlist it):');
		for (const g of r.gaps) console.log(`    ! ${opKey(g)}${g.summary ? `  — ${g.summary}` : ''}`);
	}
	if (r.nowCovered.length) {
		failed = true;
		console.log('  ALLOWLIST NOW COVERED (remove these from the provider allowlist):');
		for (const k of r.nowCovered) console.log(`    ? ${k}`);
	}
	if (r.staleAllowlist.length) {
		failed = true;
		console.log('  STALE ALLOWLIST (op no longer in live spec — prune):');
		for (const k of r.staleAllowlist) console.log(`    ? ${k}`);
	}

	if (r.snapshotChanged) {
		if (WRITE) {
			writeFileSync(r.snapshotPath, r.serialized, 'utf-8');
			console.log(`  snapshot REWRITTEN: ${r.snapshotPath}`);
		} else {
			failed = true;
			console.log('  snapshot STALE vs live spec — run `npm run api-coverage:write` and commit. Drift:');
			const committed = JSON.parse(readFileSync(r.snapshotPath, 'utf-8').trim() || '[]') as SnapshotOp[];
			for (const line of diffSummary(committed, JSON.parse(r.serialized) as SnapshotOp[])) console.log(line);
		}
	} else {
		console.log('  snapshot up to date.');
	}
}

if (!WRITE && failed) {
	console.error('\napi-coverage: drift or uncovered ops detected (see above). Exit 1.');
	process.exit(1);
}
console.log(WRITE ? '\napi-coverage: snapshots written.' : '\napi-coverage: all providers covered and snapshots current.');
