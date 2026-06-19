/**
 * Smoke tests — Supabase proxy: Management API (/v1, /v0) + Metrics (/metrics/:ref).
 *
 * Two tiers:
 *  1. Synthetic (always runs) — exercises the gatekeeper-side guarantees that need
 *     NO real Supabase credential: asset-layer wiring (run_worker_first), auth
 *     ordering, the classifier + deny-by-default policy engine, and token binding.
 *     Every deny assertion returns BEFORE any upstream call, so this tier is
 *     network-free and deterministic.
 *  2. Live API-through-proxy (opt-in) — when SUPABASE_SMOKE_PAT is set, registers
 *     the real PAT (validated) and exercises the REAL Supabase Management API
 *     through the proxy using a Gatekeeper key as the Bearer token — the actual
 *     client contract (gateway authorizes, then swaps in the stored PAT upstream).
 *     Asserts real project/org data comes back. Skipped unless a PAT is provided.
 *
 *     A key bound to a `supabase` PAT is minted `sbp_`-shaped (sbp_ + 40 hex), so
 *     it satisfies the official `supabase` CLI's client-side token regex and can be
 *     used verbatim as SUPABASE_ACCESS_TOKEN. When the `supabase` binary is present
 *     this tier additionally drives the REAL CLI through the proxy (profile file
 *     pointed at /supabase, sbp_ key as the access token).
 *
 *     SUPABASE_SMOKE_PAT   — a real Supabase Personal Access Token (sbp_...)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SmokeContext, Resp } from './helpers.js';
import { req, admin, section, assertStatus, assertMatch, assertTruthy, state, sleep, dim, BASE } from './helpers.js';

/** The official `supabase` CLI accepts only this access-token shape (client-side). */
const SBP_KEY_RE = /^sbp_(oauth_)?[a-f0-9]{40}$/;

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

	// ─── Credential validation (advisory) ──────────────────────────
	// Registration probes the credential against the real upstream by DEFAULT
	// (validate omitted == validate:true). A bogus PAT is rejected by Supabase, but
	// validation is ADVISORY: the token is still stored (200 + id) and the rejection
	// surfaces as a non-empty `warnings` array (sibling of `result`, not inside it).
	// Needs no real credential — the fake token is deterministically rejected.

	section('Supabase Proxy — Credential validation (advisory)');

	const badPatReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-sb-pat-validate',
		token: 'sbp_definitely_not_a_real_pat_value',
		scope_type: 'supabase',
		zone_ids: ['*'],
		// validate intentionally omitted — exercises the default-on probe.
	});
	assertStatus('register bogus PAT with default validation -> 200 (advisory, still stored)', badPatReg, 200);
	const badPatId = badPatReg.body?.result?.id;
	assertTruthy('bogus PAT is stored despite validation failure (advisory)', badPatId);
	if (badPatId) state.createdUpstreamTokens.push(badPatId);
	assertTruthy(
		'rejected PAT returns a non-empty warnings[] at the top level',
		Array.isArray(badPatReg.body?.warnings) && badPatReg.body.warnings.length > 0,
	);

	// The opt-out path: --no-validate / validate:false stores with no probe, no warnings.
	const skipPatReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-sb-pat-skip',
		token: 'sbp_definitely_not_a_real_pat_value',
		scope_type: 'supabase',
		zone_ids: ['*'],
		validate: false,
	});
	assertStatus('register bogus PAT with validate:false -> 200', skipPatReg, 200);
	const skipPatId = skipPatReg.body?.result?.id;
	if (skipPatId) state.createdUpstreamTokens.push(skipPatId);
	assertTruthy('validate:false skips the probe (no warnings)', !skipPatReg.body?.warnings || skipPatReg.body.warnings.length === 0);

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

	// ─── CLI-compatible key shape (synthetic, network-free) ────────
	// A key bound to a `supabase` PAT is minted sbp_-shaped so the official CLI's
	// client-side token regex accepts it; a `supabase_metrics` (HTTP Basic) key is
	// NOT the CLI's access token, so it keeps the default gw_ shape. The gateway
	// looks keys up verbatim and does not enforce a prefix, so the sbp_ key
	// authenticates exactly like a gw_ key (proven here without any upstream call).

	section('Supabase Proxy — CLI-compatible key shape');

	const { r: sbpCr, keyId: SBP_KEY } = await createSbKey(
		'smoke-sb-cli-shape',
		policy(['supabase:metrics:read'], ['supabase:account']),
		sbPatId,
	);
	assertStatus('create key bound to supabase PAT -> 200', sbpCr, 200);
	assertMatch('PAT-bound key is sbp_+40hex (passes the official CLI regex)', SBP_KEY, SBP_KEY_RE);

	// The sbp_-shaped key authenticates: this metrics-only key is DENIED (403) at the
	// policy layer on /v1/projects — a 401 would mean auth rejected the sbp_ key.
	const sbpAuthd = await sb(SBP_KEY, 'GET', '/v1/projects');
	assertStatus('sbp_-shaped key authenticates (403 at policy, not 401 at auth)', sbpAuthd, 403);

	const { r: gwCr, keyId: GW_METRICS_KEY } = await createSbKey(
		'smoke-sb-metrics-shape',
		policy(['supabase:metrics:read'], [`project:${REF_A}`]),
		sbMetId,
	);
	assertStatus('create key bound to supabase_metrics credential -> 200', gwCr, 200);
	assertMatch('metrics-bound key keeps the default gw_ shape', GW_METRICS_KEY, /^gw_[a-f0-9]{32}$/);

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

	await runLiveApiTier();
}

/**
 * Opt-in tier: register the real PAT and exercise the real Supabase Management API
 * through the proxy with a Gatekeeper key as Bearer. Proves the end-to-end live path
 * (auth -> classify -> policy -> PAT swap -> real Supabase -> real data).
 */
async function runLiveApiTier(): Promise<void> {
	if (!SUPABASE_SMOKE_PAT) {
		section('Supabase Proxy — Live API-through-proxy (skipped — no SUPABASE_SMOKE_PAT)');
		console.log(`  ${dim('Set SUPABASE_SMOKE_PAT=<real sbp_... token> to exercise the real Supabase Management API through the proxy.')}`);
		return;
	}

	section('Supabase Proxy — Live API-through-proxy');

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
		'smoke-sb-live-api',
		policy(['supabase:projects:read', 'supabase:organizations:read'], ['supabase:account']),
		liveId,
	);
	assertStatus('create live API key -> 200', liveKeyCr, 200);
	if (!LIVE_KEY) return;

	// Real Management API read through the proxy — the gw_ key is swapped for the PAT upstream.
	const projects = await sb(LIVE_KEY, 'GET', '/v1/projects');
	assertStatus('live: GET /v1/projects through proxy -> 200', projects, 200);
	assertTruthy('live: /v1/projects returns a real project array', Array.isArray(projects.body));
	if (Array.isArray(projects.body)) {
		console.log(`  ${dim(`(${projects.body.length} projects via swapped PAT)`)}`);
	}

	const orgs = await sb(LIVE_KEY, 'GET', '/v1/organizations');
	assertStatus('live: GET /v1/organizations through proxy -> 200', orgs, 200);
	assertTruthy('live: /v1/organizations returns a real array', Array.isArray(orgs.body));

	// Authorization still bites on the live path: this key has no secrets:read.
	const denySecrets = await sb(LIVE_KEY, 'GET', '/v1/projects/aaaaaaaaaaaaaaaaaaaa/secrets');
	assertStatus('live: secrets read denied (no scope) -> 403', denySecrets, 403);

	// sbp_-shaped key (PAT-bound) carries the exact token a CLI sends. Prove it works
	// end-to-end against the REAL Supabase Management API through the proxy.
	const { r: sbpKeyCr, keyId: SBP_LIVE_KEY } = await createSbKey(
		'smoke-sb-live-cli',
		policy(['supabase:projects:read'], ['supabase:account']),
		liveId,
	);
	assertStatus('create live sbp_-shaped key -> 200', sbpKeyCr, 200);
	assertMatch('live key is sbp_-shaped', SBP_LIVE_KEY, SBP_KEY_RE);
	if (!SBP_LIVE_KEY) return;

	const sbpProjects = await sb(SBP_LIVE_KEY, 'GET', '/v1/projects');
	assertStatus('live: sbp_ key GET /v1/projects through proxy -> 200', sbpProjects, 200);
	assertTruthy('live: sbp_ key returns a real project array', Array.isArray(sbpProjects.body));

	// Real-life smoke: drive the actual `supabase` binary through the proxy.
	await runOfficialCliTier(SBP_LIVE_KEY);
}

/** True if the official `supabase` CLI binary is on PATH. */
function supabaseCliAvailable(): boolean {
	try {
		execFileSync('supabase', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Drive the REAL `supabase` CLI through the proxy with the sbp_-shaped Gatekeeper
 * key as SUPABASE_ACCESS_TOKEN. A custom profile points the CLI's api_url at the
 * proxy's /supabase surface. The trailing slash on api_url is load-bearing: the
 * CLI's generated client resolves "./v1/projects" relative to api_url, so without
 * the slash the /supabase path segment is dropped.
 */
async function runOfficialCliTier(sbpKey: string): Promise<void> {
	if (!supabaseCliAvailable()) {
		section('Supabase Proxy — Official `supabase` CLI (skipped — binary not on PATH)');
		console.log(`  ${dim('Install the `supabase` CLI to exercise the real client through the proxy with an sbp_ key.')}`);
		return;
	}

	section('Supabase Proxy — Official `supabase` CLI through proxy');

	const dir = mkdtempSync(join(tmpdir(), 'gk-sb-cli-'));
	const profilePath = join(dir, 'gatekeeper.yaml');
	writeFileSync(profilePath, `name: gatekeeper\napi_url: ${BASE}/supabase/\ndashboard_url: ${BASE}\nproject_host: supabase.co\n`);

	try {
		const out = execFileSync('supabase', ['projects', 'list'], {
			env: { ...process.env, SUPABASE_PROFILE: profilePath, SUPABASE_ACCESS_TOKEN: sbpKey },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		assertTruthy('official CLI: `supabase projects list` succeeded through the proxy', typeof out === 'string');
		console.log(`  ${dim('(real `supabase` CLI authenticated with sbp_ key -> proxy -> swapped PAT -> Supabase)')}`);
	} catch (e: any) {
		const stderr = (e?.stderr ?? e?.message ?? '').toString().trim().slice(0, 300);
		assertTruthy(`official CLI: \`supabase projects list\` exit 0 (stderr: ${stderr})`, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
