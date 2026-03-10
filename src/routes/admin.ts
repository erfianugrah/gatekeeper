import { Hono } from 'hono';
import { adminAuth, requireRole, requireRoleByMethod } from '../auth-admin';
import { adminKeysApp } from './admin-keys';
import { adminAnalyticsApp } from './admin-analytics';
import { adminDnsAnalyticsApp } from './admin-dns-analytics';
import { adminCfAnalyticsApp } from './admin-cf-analytics';
import { adminS3App } from './admin-s3';
import { adminUpstreamTokensApp } from './admin-upstream-tokens';
import { adminUpstreamR2App } from './admin-upstream-r2';
import { adminConfigApp } from './admin-config';
import { adminAuditApp } from './admin-audit';
import { jsonError } from './admin-schemas';
import type { HonoEnv } from '../types';

// ─── Admin compositor ───────────────────────────────────────────────────────
// Thin shell that mounts auth + RBAC middleware and delegates to domain sub-apps.
//
// Role requirements:
//   viewer:   GET on any route (analytics, list/get resources, config)
//   operator: viewer + write access to keys and S3 credentials
//   admin:    operator + upstream tokens, upstream R2, config writes

export const adminApp = new Hono<HonoEnv>();

/** Global error handler — catches unhandled throws and returns structured JSON. */
adminApp.onError((err, c) => {
	console.error(JSON.stringify({ route: 'admin', error: err.message, ts: new Date().toISOString() }));
	return jsonError(c, 500, 'Internal server error');
});

// Authentication — sets adminRole in context
adminApp.use('*', adminAuth);

// ─── /admin/me — current user identity + role ──────────────────────────────

adminApp.get('/me', (c) => {
	const identity = c.get('accessIdentity');
	const role = c.get('adminRole') ?? 'admin';

	return c.json({
		success: true,
		result: {
			email: identity?.email ?? null,
			role,
			groups: identity?.groups ?? [],
			authMethod: identity ? 'access' : 'api-key',
			logoutUrl: c.env.CF_ACCESS_TEAM_NAME ? '/logout' : null,
		},
	});
});

// RBAC — per-sub-app role requirements
// Keys and S3 creds: viewer for reads, operator for writes
adminApp.use('/keys/*', requireRoleByMethod('viewer', 'operator'));
adminApp.use('/keys', requireRoleByMethod('viewer', 'operator'));
adminApp.use('/analytics/*', requireRole('viewer'));
adminApp.use('/dns/*', requireRole('viewer'));
adminApp.use('/cf/*', requireRole('viewer'));
adminApp.use('/s3/*', requireRoleByMethod('viewer', 'operator'));
adminApp.use('/s3', requireRoleByMethod('viewer', 'operator'));

// Upstream tokens and R2 — admin only (these hold secrets)
adminApp.use('/upstream-tokens/*', requireRole('admin'));
adminApp.use('/upstream-tokens', requireRole('admin'));
adminApp.use('/upstream-r2/*', requireRole('admin'));
adminApp.use('/upstream-r2', requireRole('admin'));

// Config — viewer for reads, admin for writes
adminApp.use('/config/*', requireRoleByMethod('viewer', 'admin'));
adminApp.use('/config', requireRoleByMethod('viewer', 'admin'));

// Audit log — viewer can read
adminApp.use('/audit/*', requireRole('viewer'));

adminApp.route('/keys', adminKeysApp);
adminApp.route('/analytics', adminAnalyticsApp);
adminApp.route('/dns/analytics', adminDnsAnalyticsApp);
adminApp.route('/cf/analytics', adminCfAnalyticsApp);
adminApp.route('/s3', adminS3App);
adminApp.route('/upstream-tokens', adminUpstreamTokensApp);
adminApp.route('/upstream-r2', adminUpstreamR2App);
adminApp.route('/config', adminConfigApp);
adminApp.route('/audit', adminAuditApp);
