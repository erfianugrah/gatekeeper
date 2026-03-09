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
 *   1. Bearer token extraction
 *   2. Account ID validation
 *   3. Account-level rate limiting (cfProxyBucket)
 *
 * Upstream token resolution happens AFTER authentication in each service handler
 * to prevent unauthenticated callers from probing which accounts have tokens.
 *
 * Per-service routes (D1, KV, Workers, etc.) are mounted as sub-apps.
 */

import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { isValidAccountId, isValidZoneId, extractBearerKey, cfJsonError } from './proxy-helpers';
import { d1Routes } from './d1/routes';
import { kvRoutes } from './kv/routes';
import { workersRoutes } from './workers/routes';
import { queuesRoutes } from './queues/routes';
import { vectorizeRoutes } from './vectorize/routes';
import { hyperdriveRoutes } from './hyperdrive/routes';
import { dnsRoutes } from './dns/routes';

// ─── Shared context type ────────────────────────────────────────────────────

/** Variables set by the CF proxy middleware, available to all downstream handlers. */
export interface CfProxyVars {
	/** The Gatekeeper API key ID (raw bearer token). */
	keyId: string;
	/** Human-readable key name from successful auth (for audit trails). */
	keyName: string | undefined;
	/** The validated 32-hex-char Cloudflare account ID from the URL path. Empty for zone-scoped routes. */
	accountId: string;
	/** The validated 32-hex-char Cloudflare zone ID from the URL path. Empty for account-scoped routes. */
	zoneId: string;
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
 * Runs bearer extraction, account validation, and rate limiting.
 * Upstream token resolution is deferred to service handlers (post-auth).
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

	// 3. Rate limit — account-level CF proxy bucket
	const stub = getStub(c.env);
	const consumeResult = await stub.consumeCfProxyRateLimit();
	if (!consumeResult.allowed) {
		log.status = 429;
		log.error = 'rate_limited';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(429, 'Rate limit exceeded');
	}

	// 4. Extract request fields for policy conditions
	const requestFields = extractRequestFields(c.req.raw);

	// Set variables for downstream handlers
	c.set('keyId', keyId);
	c.set('accountId', accountId);
	c.set('zoneId', '');
	c.set('startTime', start);
	c.set('log', log);
	c.set('requestFields', requestFields);
	// keyName will be set after auth in each service handler

	await next();
});

/**
 * Zone-scoped middleware for DNS and other zone-level services.
 * Same pattern as account-scoped, but validates zone ID and uses the bulk rate bucket.
 */
cfApp.use('/zones/:zoneId/*', async (c, next) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'cf-proxy-zone', ts: new Date().toISOString() };

	// 1. Extract Bearer key
	const keyId = extractBearerKey(c.req.header('Authorization'));
	if (!keyId) {
		return cfJsonError(401, 'Missing or invalid Authorization: Bearer <key>');
	}
	log.keyId = keyId.slice(0, 12) + '...';

	// 2. Validate zone ID
	const zoneId = c.req.param('zoneId');
	if (!isValidZoneId(zoneId)) {
		return cfJsonError(400, 'Invalid zone ID format');
	}
	log.zoneId = zoneId;

	// 3. Extract request fields for policy conditions
	const requestFields = extractRequestFields(c.req.raw);

	// Set variables for downstream handlers
	c.set('keyId', keyId);
	c.set('accountId', '');
	c.set('zoneId', zoneId);
	c.set('startTime', start);
	c.set('log', log);
	c.set('requestFields', requestFields);

	await next();
});

// ─── Mount per-service routes ───────────────────────────────────────────────

// Account-scoped services
cfApp.route('/accounts/:accountId/d1', d1Routes);
cfApp.route('/accounts/:accountId/storage/kv', kvRoutes);
cfApp.route('/accounts/:accountId/workers', workersRoutes);
cfApp.route('/accounts/:accountId/queues', queuesRoutes);
cfApp.route('/accounts/:accountId/vectorize', vectorizeRoutes);
cfApp.route('/accounts/:accountId/hyperdrive', hyperdriveRoutes);

// Zone-scoped services
cfApp.route('/zones/:zoneId', dnsRoutes);
