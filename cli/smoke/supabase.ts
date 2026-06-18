/**
 * Smoke tests — Supabase proxy: Management API (/v1, /v0) + Metrics (/metrics/:ref).
 *
 * Two tiers:
 *  1. Synthetic (always runs) — exercises the gatekeeper-side guarantees that need
 *     NO real Supabase credential: asset-layer wiring (run_worker_first), auth
 *     ordering, the classifier + deny-by-default policy engine, and token binding.
 *     Every deny assertion returns BEFORE any upstream call, so this tier is
 *     network-free and deterministic.
 *  2. Live CLI-through-proxy (opt-in) — when SUPABASE_SMOKE_PAT is set, registers
 *     the real PAT and drives the OFFICIAL `supabase` CLI through the proxy
 *     (SUPABASE_API_URL=<gateway>/supabase, SUPABASE_ACCESS_TOKEN=<gatekeeper key>).
 *     This is the true "test the actual API" path — any wire-incompatibility
 *     surfaces through the real client. Skipped unless a PAT is provided.
 *
 *     SUPABASE_SMOKE_PAT   — a real Supabase Personal Access Token (sbp_...)
 *     SUPABASE_GO_BINARY   — passed through if the local `supabase` shim needs it
 */

import { execSync } from 'node:child_process';
import type { SmokeContext, Resp } from './helpers.js';
import { req, admin, section, assertStatus, assertMatch, assertTruthy, state, sleep, green, red, dim, yellow, BASE } from './helpers.js';

// ─── Constants ──────────────────────────────────────────────────────────────

// 20-char [a-z0-9] project-ref shapes (SUPABASE_REF_RE) — fake but well-formed.
const REF_A = 'aaaaaaaaaaaaaaaaaaaa';
const REF_B = 'bbbbbbbbbbbbbbbbbbbb';

const SUPABASE_SMOKE_PAT = process.env['SUPABASE_SMOKE_PAT'];
const SUPABASE_SMOKE_REF = process.env['SUPABASE_SMOKE_REF'];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Issue a request through the Supabase proxy with a Bearer gatekeeper key. */
function sb(keyId: string, method: string, path: string, body?: unknown): Promise<Resp> {
	const headers: Record<string, string> = { Authorization: `Bearer ${keyId}` };
	if (body) headers['Content-Type'] = 'application/json';
	return req(method, `/supabase${path}`, body, headers);
}

/** Create a Supabase-scoped gatekeeper key bound to an upstream token. */
async function createSbKey(name: string, policy: object, upstreamTokenId: string): Promise<{ r: Resp; keyId: string }> {
	const r = await admin('POST', '/admin/keys', { name, policy, upstream_token_id: upstreamTokenId });
	const keyId = r.body?.result?.key?.id ?? '';
	if (keyId) state.createdKeys.push(keyId);
	return { r, keyId };
}

/** A JSON proxy response must NOT be the SPA dashboard fallback (run_worker_first guard). */
function isJsonNotHtml(r: Resp): boolean {
	const ct = r.headers.get('content-type') ?? '';
	return ct.includes('application/json') && !r.raw.trimStart().startsWith('<');
}

const policy = (actions: string[], resources: string[]) => ({
	version: '2025-01-01',
	statements: [{ effect: 'allow', actions, resources }],
});

export async function run(ctx: SmokeContext): Promise<void> {
	// ─── Upstream token setup ──────────────────────────────────────

	section('Supabase Proxy Upstream Token Setup');

	const patReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-sb-pat',
		token: 'sbp_fake_smoke_personal_access_token',
		scope_type: 'supabase',
		zone_ids: ['*'],
		validate: false,
	});
	assertStatus('register Supabase PAT token -> 200', patReg, 200);
	const sbPatId = patReg.body?.result?.id;
	assertTruthy('Supabase PAT token has id', sbPatId);
	if (sbPatId) state.createdUpstreamTokens.push(sbPatId);

	const metReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-sb-metrics',
		token: 'fake_metrics_secret_value',
		scope_type: 'supabase_metrics',
		auth_type: 'basic',
		username: 'service_role',
		zone_ids: [REF_A],
		validate: false,
	});
	assertStatus('register Supabase Metrics token -> 200', metReg, 200);
	const sbMetId = metReg.body?.result?.id;
	assertTruthy('Supabase Metrics token has id', sbMetId);
	if (sbMetId) state.createdUpstreamTokens.push(sbMetId);

	// ─── Asset-layer wiring (run_worker_first) ─────────────────────
	// Unlisted paths get the dashboard index.html (HTTP 200) from the asset layer
	// BEFORE the worker runs. These assert the worker actually handles the route.

	section('Supabase Proxy — Asset-layer wiring (run_worker_first)');

	const w1 = await req('GET', '/supabase/v1/projects');
	assertStatus('v1 no-auth -> 401', w1, 401);
	assertTruthy('v1 returns JSON, not the dashboard SPA shell', isJsonNotHtml(w1));

	const w0 = await req('GET', `/supabase/v0/projects/${REF_A}/analytics/metrics`);
	assertStatus('v0 no-auth -> 401', w0, 401);
	assertTruthy('v0 returns JSON, not the dashboard SPA shell', isJsonNotHtml(w0));

	const wm = await req('GET', `/supabase/metrics/${REF_A}`);
	assertStatus('metrics no-auth -> 401', wm, 401);
	assertTruthy('metrics returns JSON, not the dashboard SPA shell', isJsonNotHtml(wm));

	// ─── Authentication ordering ───────────────────────────────────

	section('Supabase Proxy — Authentication ordering');

	const noAuth = await req('GET', '/supabase/v1/projects');
	assertStatus('missing Authorization -> 401', noAuth, 401);

	// Bad key on a MAPPED path -> 401 (auth resolves before the upstream credential;
	// a 502 here would leak which refs have a stored PAT).
	const badKey = await sb('gw_00000000000000000000000000000000', 'GET', '/v1/projects');
	assertStatus('bad key + mapped path -> 401 (auth before credential resolve)', badKey, 401);

	// Unmapped paths classify to null -> 404 deny-by-default (before auth validity —
	// only a bearer needs to be present).
	const unmappedV0 = await sb('gw_00000000000000000000000000000000', 'GET', `/v0/projects/${REF_A}/not-a-real-endpoint`);
	assertStatus('unmapped /v0 path -> 404 (deny-by-default classifier)', unmappedV0, 404);

	const unmappedV1 = await sb('gw_00000000000000000000000000000000', 'GET', '/v1/totally/unmapped/surface');
	assertStatus('unmapped /v1 path -> 404 (deny-by-default classifier)', unmappedV1, 404);

	// ─── Token binding validation ──────────────────────────────────

	section('Supabase Proxy — Token binding validation');

	const bindCfAction = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: sbPatId,
		policy: policy(['purge:*'], ['supabase:account']),
	});
	assertStatus('Supabase token + Cloudflare action -> 400', bindCfAction, 400);
	assertMatch('error mentions supabase token', bindCfAction.body?.errors?.[0]?.message ?? '', /supabase/i);

	const bindBadResource = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: sbPatId,
		policy: policy(['supabase:projects:read'], ['zone:abc']),
	});
	assertStatus('Supabase token + zone resource -> 400', bindBadResource, 400);
	assertMatch(
		'error mentions project/org/branch shape',
		bindBadResource.body?.errors?.[0]?.message ?? '',
		/project:|org:|branch:|supabase:account/i,
	);

	// ─── Authorization: classifier + deny-by-default ───────────────
	// All assertions here return 403 BEFORE any upstream call (network-free), and
	// prove the classifier maps each path to the right action.

	section('Supabase Proxy — Authorization (classifier + deny-by-default)');

	const { r: moCr, keyId: METRICS_ONLY_KEY } = await createSbKey(
		'smoke-sb-metrics-only',
		policy(['supabase:metrics:read'], ['supabase:account']),
		sbPatId,
	);
	assertStatus('create metrics-only key -> 200', moCr, 200);
	const denyProjects = await sb(METRICS_ONLY_KEY, 'GET', '/v1/projects');
	assertStatus('metrics-only key: GET /v1/projects -> 403 (needs projects:read)', denyProjects, 403);

	const { r: prCr, keyId: PROJECTS_KEY } = await createSbKey(
		'smoke-sb-projects',
		policy(['supabase:projects:read'], ['supabase:account']),
		sbPatId,
	);
	assertStatus('create projects-read key -> 200', prCr, 200);
	const denyOrgs = await sb(PROJECTS_KEY, 'GET', '/v1/organizations');
	assertStatus('projects-read key: GET /v1/organizations -> 403 (needs organizations:read)', denyOrgs, 403);

	const { r: orCr, keyId: ORGS_KEY } = await createSbKey(
		'smoke-sb-orgs',
		policy(['supabase:organizations:read'], ['supabase:account']),
		sbPatId,
	);
	assertStatus('create orgs-read key -> 200', orCr, 200);
	const denyProjects2 = await sb(ORGS_KEY, 'GET', '/v1/projects');
	assertStatus('orgs-read key: GET /v1/projects -> 403 (needs projects:read)', denyProjects2, 403);

	// Metrics surface: key scoped to REF_A, request REF_B -> 403 (resource mismatch, network-free).
	const { r: msCr, keyId: METRICS_SCOPED_KEY } = await createSbKey(
		'smoke-sb-metrics-scoped',
		policy(['supabase:metrics:read'], [`project:${REF_A}`]),
		sbMetId,
	);
	assertStatus('create metrics-scoped key -> 200', msCr, 200);
	const denyMetricsRef = await sb(METRICS_SCOPED_KEY, 'GET', `/metrics/${REF_B}`);
	assertStatus('metrics key scoped to REF_A: GET /metrics/REF_B -> 403 (resource mismatch)', denyMetricsRef, 403);

	// ─── Analytics admin endpoints ─────────────────────────────────

	section('Supabase Proxy Analytics');

	await sleep(1000); // fire-and-forget D1 writes

	const events = await admin('GET', '/admin/supabase/analytics/events');
	assertStatus('supabase analytics events -> 200', events, 200);
	assertTruthy('events result is an array', Array.isArray(events.body?.result));

	const summary = await admin('GET', '/admin/supabase/analytics/summary');
	assertStatus('supabase analytics summary -> 200', summary, 200);
	assertTruthy('summary has total_requests', typeof summary.body?.result?.total_requests === 'number');

	const ts = await admin('GET', '/admin/supabase/analytics/timeseries');
	assertStatus('supabase analytics timeseries -> 200', ts, 200);
	assertTruthy('timeseries result is an array', Array.isArray(ts.body?.result));

	// ─── Live CLI-through-proxy (opt-in) ───────────────────────────

	await runLiveCliTier(sbPatId);
}

/**
 * Opt-in tier: register the real PAT and drive the official `supabase` CLI through
 * the proxy. Proves end-to-end wire compatibility with a real Supabase client.
 */
async function runLiveCliTier(sbPatId: string | undefined): Promise<void> {
	if (!SUPABASE_SMOKE_PAT) {
		section('Supabase Proxy — Live CLI-through-proxy (skipped — no SUPABASE_SMOKE_PAT)');
		console.log(`  ${dim('Set SUPABASE_SMOKE_PAT=<real sbp_... token> to drive the official supabase CLI through the proxy.')}`);
		return;
	}

	section('Supabase Proxy — Live CLI-through-proxy');

	// Register the real PAT (validated) and a key that can list projects.
	const realReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-sb-pat-live',
		token: SUPABASE_SMOKE_PAT,
		scope_type: 'supabase',
		zone_ids: ['*'],
		validate: true,
	});
	assertStatus('register real Supabase PAT (validated) -> 200', realReg, 200);
	const liveId = realReg.body?.result?.id;
	if (liveId) state.createdUpstreamTokens.push(liveId);
	if (!liveId) return;

	const { r: liveKeyCr, keyId: LIVE_KEY } = await createSbKey(
		'smoke-sb-live-cli',
		policy(['supabase:projects:read', 'supabase:organizations:read'], ['supabase:account']),
		liveId,
	);
	assertStatus('create live CLI key -> 200', liveKeyCr, 200);
	if (!LIVE_KEY) return;

	// Drive the official supabase CLI through the proxy.
	const env: Record<string, string> = {
		...process.env,
		SUPABASE_API_URL: `${BASE}/supabase`,
		SUPABASE_ACCESS_TOKEN: LIVE_KEY,
	};

	const result = (() => {
		try {
			const out = execSync('supabase projects list -o json', {
				env,
				timeout: 30_000,
				stdio: ['pipe', 'pipe', 'pipe'],
				encoding: 'utf-8',
			});
			return { ok: true, out: out.trim() };
		} catch (e: any) {
			return { ok: false, out: (e.stderr?.toString() || e.stdout?.toString() || e.message || '').trim() };
		}
	})();

	if (result.ok) {
		state.pass++;
		let count = 0;
		try {
			count = JSON.parse(result.out).length;
		} catch {
			/* non-JSON output still counts as a successful exit */
		}
		console.log(`  ${green('PASS')}  supabase CLI 'projects list' through proxy ${dim(`(${count} projects)`)}`);
	} else {
		state.fail++;
		state.errors.push(`supabase CLI through proxy: ${result.out.slice(0, 160)}`);
		console.log(`  ${red('FAIL')}  supabase CLI 'projects list' through proxy ${dim(`(${result.out.slice(0, 160)})`)}`);
	}
}
