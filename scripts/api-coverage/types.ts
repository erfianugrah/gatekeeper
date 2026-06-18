/**
 * API coverage framework — shared contract.
 *
 * Gatekeeper fronts several upstream APIs (Supabase Management, Cloudflare, S3/R2).
 * Each proxy classifies inbound requests to a Gatekeeper action; anything unclassified
 * is denied by default. That fails *safe* but causes silent coverage lag when an upstream
 * adds or moves an endpoint.
 *
 * A `CoverageProvider` is the single extension point: implement it once per upstream and
 * register it in `registry.ts`. The drift refresh (`refresh.ts`) and the coverage test
 * (`test/api-coverage.test.ts`) both iterate the registry generically — adding a new API
 * is one conforming module + one registration line + one committed snapshot, never a
 * bespoke add-on.
 */

/** One upstream operation: HTTP method + path template. */
export interface ApiOp {
	method: string;
	/** Path template, e.g. `/v1/projects/{ref}/database/query`. */
	path: string;
	/** Optional human summary from the upstream spec (for drift reports). */
	summary?: string;
}

/** A committed snapshot row: an op plus the proxy's coverage verdict at snapshot time. */
export interface SnapshotOp extends ApiOp {
	/** Did the proxy classify/handle this op when the snapshot was generated? */
	covered: boolean;
}

export interface CoverageProvider {
	/** Stable id, e.g. `supabase`. Used for snapshot filenames and report grouping. */
	id: string;
	/** Human label for reports. */
	label: string;
	/** Committed baseline snapshot path, relative to repo root. The drift job rewrites it. */
	snapshotPath: string;
	/**
	 * The committed baseline, statically imported from `snapshotPath`. The hermetic coverage
	 * test reads this (never the network) so it runs offline in the Workers pool.
	 */
	snapshot: SnapshotOp[];
	/**
	 * Fetch the authoritative upstream operation set. For spec-backed APIs this is an HTTP
	 * fetch of the OpenAPI doc; for non-spec APIs (S3) it returns the curated baseline list.
	 * MUST be free of `cloudflare:workers` imports so it runs in plain tsx (the refresh job).
	 */
	fetchLiveOps(): Promise<ApiOp[]>;
	/**
	 * Does the proxy classify/handle this operation? Pure — uses the proxy's own classifier
	 * (classifySupabaseRequest, detectOperation, …). Runs in vitest where worker imports resolve.
	 */
	isCovered(op: ApiOp): boolean;
	/** Operations intentionally NOT covered, keyed by `opKey`, with a reason. Keeps non-coverage conscious. */
	allowlist: Record<string, string>;
}

/** Canonical key for an operation: `METHOD path`. */
export function opKey(op: ApiOp): string {
	return `${op.method.toUpperCase()} ${op.path}`;
}

/** Build a deterministic, coverage-annotated snapshot from a live op set + a coverage predicate. */
export function buildSnapshot(ops: ApiOp[], isCovered: (op: ApiOp) => boolean): SnapshotOp[] {
	return ops
		.map((op) => ({ method: op.method.toUpperCase(), path: op.path, summary: op.summary, covered: isCovered(op) }))
		.sort((a, b) => opKey(a).localeCompare(opKey(b)));
}

/** Serialize a snapshot to deterministic JSON (stable order, trailing newline) for git-diff-friendly commits. */
export function serializeSnapshot(snapshot: SnapshotOp[]): string {
	return `${JSON.stringify(snapshot, null, '\t')}\n`;
}

/** Extract `{method, path, summary}` ops from an OpenAPI 3 document. */
export function extractOpenApiOps(spec: { paths?: Record<string, Record<string, { summary?: string }>> }): ApiOp[] {
	const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
	const ops: ApiOp[] = [];
	for (const [path, item] of Object.entries(spec.paths ?? {})) {
		for (const m of methods) {
			const op = item[m];
			if (!op) continue;
			ops.push({ method: m.toUpperCase(), path, summary: op.summary });
		}
	}
	return ops.sort((a, b) => opKey(a).localeCompare(opKey(b)));
}
