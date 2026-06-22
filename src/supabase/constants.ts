// ─── Supabase upstream constants ────────────────────────────────────────────

export const SUPABASE_API_BASE = 'https://api.supabase.com';

/** Per-project data-plane host template; `<ref>` replaced at call time. */
export const SUPABASE_PROJECT_HOST = (ref: string): string => `https://${ref}.supabase.co`;

/** The Prometheus-compatible per-project metrics endpoint path. */
export const SUPABASE_METRICS_PATH = '/customer/v1/privileged/metrics';

// A Supabase project ref is 20 lowercase alphanumeric chars (confirmed against a live project
// `dewddkcmwrzbpynylyhg` on 2026-06-18). Tight enough to block SSRF via the metrics host
// (`https://<ref>.supabase.co`), loose enough to accept any real ref.
export const SUPABASE_REF_RE = /^[a-z0-9]{20}$/;

/** Path segments that appear in the ref position but are NOT refs (collection routes). */
export const PROJECT_REF_LITERALS = new Set(['available-regions']);

export type SupabaseCategory =
	| 'auth'
	| 'database'
	| 'domains'
	| 'edge_functions'
	| 'environment'
	| 'organizations'
	| 'oauth'
	| 'profile'
	| 'projects'
	| 'rest'
	| 'secrets'
	| 'snippets'
	| 'storage'
	| 'metrics';
