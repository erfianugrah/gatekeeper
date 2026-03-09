/**
 * Top-level CF API proxy router.
 *
 * Mounted at `/cf` in the main app, this sub-app proxies requests to the Cloudflare API
 * (`https://api.cloudflare.com/client/v4/accounts/:accountId/...`) with IAM policy enforcement,
 * account-level rate limiting, and D1 analytics.
 *
 * Wrangler users set `CLOUDFLARE_API_BASE_URL=https://<gateway>/cf` so all wrangler CLI
 * requests flow through Gatekeeper, which authenticates, evaluates fine-grained policies,
 * and proxies to the real CF API.
 *
 * Shared middleware handles:
 *   1. Bearer token extraction + IAM authentication
 *   2. Account ID validation
 *   3. Upstream token resolution (scope_type = 'account')
 *   4. Account-level rate limiting (cfProxyBucket)
 *
 * Per-service routes (D1, KV, Workers, etc.) are mounted as sub-apps.
 */

import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { isValidAccountId, extractBearerKey, cfJsonError } from './proxy-helpers';
import { d1Routes } from './d1/routes';
import { kvRoutes } from './kv/routes';
import type { HonoEnv } from '../types';
import type { AuthResult } from '../types';

// ─── Shared context type ────────────────────────────────────────────────────

/** Variables set by the CF proxy middleware, available to all downstream handlers. */
export interface CfProxyVars {
	/** The Gatekeeper API key ID (raw bearer token). */
	keyId: string;
	/** Human-readable key name from successful auth (for audit trails). */
	keyName: string | undefined;
	/** The validated 32-hex-char Cloudflare account ID from the URL path. */
	accountId: string;
	/** The resolved upstream Cloudflare API token for this account. */
	upstreamToken: string;
	/** Request start time (ms) for duration tracking. */
	startTime: number;
	/** Structured breadcrumb log object — route handlers append fields. */
	log: Record<string, unknown>;
	/** Extracted request fields (IP, country, ASN, time) for policy conditions. */
	requestFields: Record<string, string>;
}

/** Hono env for the CF proxy sub-app. */
export type CfProxyEnv = {
	Bindings: Env;
	Variables: CfProxyVars;
};

// ─── Router ─────────────────────────────────────────────────────────────────

export const cfApp = new Hono<CfProxyEnv>();

/**
 * Shared middleware for all CF proxy routes.
 * Runs auth, account validation, upstream token resolution, and rate limiting.
 * Sets CfProxyVars on the context for downstream handlers.
 */
cfApp.use('/accounts/:accountId/*', async (c, next) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'cf-proxy', ts: new Date().toISOString() };

	// 1. Extract Bearer key
	const keyId = extractBearerKey(c.req.header('Authorization'));
	if (!keyId) {
		return cfJsonError(401, 'Missing or invalid Authorization: Bearer <key>');
	}
	log.keyId = keyId.slice(0, 12) + '...';

	// 2. Validate account ID
	const accountId = c.req.param('accountId');
	if (!isValidAccountId(accountId)) {
		return cfJsonError(400, 'Invalid account ID format');
	}
	log.accountId = accountId;

	// 3. Resolve upstream token for this account
	const stub = getStub(c.env);
	const upstreamToken = await stub.resolveUpstreamAccountToken(accountId);
	if (!upstreamToken) {
		log.status = 502;
		log.error = 'no_upstream_account_token';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(502, `No upstream API token registered for account ${accountId}`);
	}

	// 4. Rate limit — account-level CF proxy bucket
	const consumeResult = await stub.consumeCfProxyRateLimit();
	if (!consumeResult.allowed) {
		log.status = 429;
		log.error = 'rate_limited';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(429, 'Rate limit exceeded');
	}

	// 5. Extract request fields for policy conditions
	const requestFields = extractRequestFields(c.req.raw);

	// Set variables for downstream handlers
	c.set('keyId', keyId);
	c.set('accountId', accountId);
	c.set('upstreamToken', upstreamToken);
	c.set('startTime', start);
	c.set('log', log);
	c.set('requestFields', requestFields);
	// keyName will be set after auth in each service handler

	await next();
});

// ─── Mount per-service routes ───────────────────────────────────────────────

cfApp.route('/accounts/:accountId/d1', d1Routes);
cfApp.route('/accounts/:accountId/storage/kv', kvRoutes);

// Future: cfApp.route('/accounts/:accountId/workers', workersRoutes);
// Future: cfApp.route('/accounts/:accountId/queues', queuesRoutes);
// Future: cfApp.route('/accounts/:accountId/vectorize', vectorizeRoutes);
// Future: cfApp.route('/accounts/:accountId/hyperdrive', hyperdriveRoutes);
