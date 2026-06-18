/**
 * Coverage provider: Supabase Management API.
 *
 * Spec-backed: fetches the live OpenAPI doc and runs every operation through the proxy's
 * own `classifySupabaseRequest`. Anything that classifies to null is either a genuine
 * coverage gap or an intentional out-of-scope group (recorded in `allowlist`).
 */

import { classifySupabaseRequest } from '../../../src/supabase/classify';
import { extractOpenApiOps, opKey, type ApiOp, type CoverageProvider, type SnapshotOp } from '../types';
import snapshot from '../fixtures/supabase.ops.json';

const SPEC_URL = 'https://api.supabase.com/api/v1-json';

/** Representative concrete values for path-template params, so the classifier's ref/slug guards pass. */
const PARAM_SAMPLES: Record<string, string> = {
	ref: 'dewddkcmwrzbpynylyhg',
	project_id: 'dewddkcmwrzbpynylyhg',
	project_ref: 'dewddkcmwrzbpynylyhg',
	branch_id_or_ref: 'br_abc123',
	slug: 'my-org',
	slug_or_id: 'my-org',
	token: 'tok123',
	id: 'snippet123',
	function_slug: 'fn1',
	provider_id: 'p1',
	tpa_id: 't1',
	connection_id: 'c1',
	database_id: 'db1',
};

/** Substitute `{param}` placeholders with representative concrete values. */
function concretePath(template: string): string {
	return template.replace(/\{([^}]+)\}/g, (_, name) => PARAM_SAMPLES[name] ?? 'x');
}

export const supabaseProvider: CoverageProvider = {
	id: 'supabase',
	label: 'Supabase Management API',
	snapshotPath: 'scripts/api-coverage/fixtures/supabase.ops.json',
	snapshot: snapshot as SnapshotOp[],

	async fetchLiveOps(): Promise<ApiOp[]> {
		const res = await fetch(SPEC_URL, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`Supabase spec fetch failed: HTTP ${res.status}`);
		return extractOpenApiOps(await res.json());
	},

	isCovered(op: ApiOp): boolean {
		return classifySupabaseRequest(op.method, concretePath(op.path)) !== null;
	},

	// Account-level / out-of-RBAC-scope groups. Each Supabase op here is denied by default on
	// purpose (the overlay scopes project/branch/org resources, not the PAT-owner's account surface).
	allowlist: {
		'GET /v1/oauth/authorize': 'OAuth app flow — account-level, out of RBAC scope',
		'POST /v1/oauth/token': 'OAuth app flow — account-level, out of RBAC scope',
		'POST /v1/oauth/revoke': 'OAuth app flow — account-level, out of RBAC scope',
		'GET /v1/oauth/authorize/project-claim': 'OAuth app flow — account-level, out of RBAC scope',
		'GET /v1/profile': 'PAT-owner profile — account-level, out of RBAC scope',
		'GET /v1/snippets': 'SQL snippets owned by the PAT user — account-level, out of RBAC scope',
		'GET /v1/snippets/{id}': 'SQL snippets owned by the PAT user — account-level, out of RBAC scope',
	},
};

export { opKey };
