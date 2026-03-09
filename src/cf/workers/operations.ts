/**
 * Workers request classification and IAM context building.
 *
 * Maps incoming HTTP requests to Workers IAM actions and extracts condition fields
 * for policy evaluation. Follows the same pattern as src/cf/d1/operations.ts.
 *
 * Workers API surface (from CF API / SDK):
 *
 * Scripts CRUD:
 *   PUT    /accounts/:acct/workers/scripts/:scriptName                            -> workers:update_script      (multipart)
 *   GET    /accounts/:acct/workers/scripts                                        -> workers:list_scripts
 *   GET    /accounts/:acct/workers/scripts/:scriptName                            -> workers:get_script         (returns JS)
 *   DELETE /accounts/:acct/workers/scripts/:scriptName                            -> workers:delete_script
 *
 * Script content (versioned upload/download):
 *   PUT    /accounts/:acct/workers/scripts/:scriptName/content                    -> workers:update_content     (multipart)
 *   GET    /accounts/:acct/workers/scripts/:scriptName/content/v2                 -> workers:get_content        (binary)
 *
 * Settings:
 *   PATCH  /accounts/:acct/workers/scripts/:scriptName/settings                   -> workers:update_settings    (multipart)
 *   GET    /accounts/:acct/workers/scripts/:scriptName/settings                   -> workers:get_settings
 *   PATCH  /accounts/:acct/workers/scripts/:scriptName/script-settings            -> workers:update_script_settings
 *   GET    /accounts/:acct/workers/scripts/:scriptName/script-settings            -> workers:get_script_settings
 *
 * Versions:
 *   POST   /accounts/:acct/workers/scripts/:scriptName/versions                   -> workers:create_version     (multipart)
 *   GET    /accounts/:acct/workers/scripts/:scriptName/versions                   -> workers:list_versions
 *   GET    /accounts/:acct/workers/scripts/:scriptName/versions/:versionId        -> workers:get_version
 *
 * Deployments:
 *   POST   /accounts/:acct/workers/scripts/:scriptName/deployments                -> workers:create_deployment
 *   GET    /accounts/:acct/workers/scripts/:scriptName/deployments                -> workers:list_deployments
 *   GET    /accounts/:acct/workers/scripts/:scriptName/deployments/:deploymentId  -> workers:get_deployment
 *   DELETE /accounts/:acct/workers/scripts/:scriptName/deployments/:deploymentId  -> workers:delete_deployment
 *
 * Secrets:
 *   PUT    /accounts/:acct/workers/scripts/:scriptName/secrets                    -> workers:update_secret
 *   GET    /accounts/:acct/workers/scripts/:scriptName/secrets                    -> workers:list_secrets
 *   DELETE /accounts/:acct/workers/scripts/:scriptName/secrets/:secretName        -> workers:delete_secret
 *   GET    /accounts/:acct/workers/scripts/:scriptName/secrets/:secretName        -> workers:get_secret
 *
 * Schedules (cron triggers):
 *   PUT    /accounts/:acct/workers/scripts/:scriptName/schedules                  -> workers:update_schedules
 *   GET    /accounts/:acct/workers/scripts/:scriptName/schedules                  -> workers:get_schedules
 *
 * Tails (live log tailing):
 *   POST   /accounts/:acct/workers/scripts/:scriptName/tails                      -> workers:create_tail
 *   DELETE /accounts/:acct/workers/scripts/:scriptName/tails/:tailId              -> workers:delete_tail
 *   GET    /accounts/:acct/workers/scripts/:scriptName/tails                      -> workers:list_tails
 *
 * Script subdomain (workers.dev toggle):
 *   POST   /accounts/:acct/workers/scripts/:scriptName/subdomain                  -> workers:update_subdomain
 *   DELETE /accounts/:acct/workers/scripts/:scriptName/subdomain                  -> workers:delete_subdomain
 *   GET    /accounts/:acct/workers/scripts/:scriptName/subdomain                  -> workers:get_subdomain
 *
 * Assets upload:
 *   POST   /accounts/:acct/workers/scripts/:scriptName/assets-upload-session      -> workers:upload_assets
 *
 * Account subdomain:
 *   PUT    /accounts/:acct/workers/subdomain                                      -> workers:update_account_subdomain
 *   DELETE /accounts/:acct/workers/subdomain                                      -> workers:delete_account_subdomain
 *   GET    /accounts/:acct/workers/subdomain                                      -> workers:get_account_subdomain
 *
 * Account settings:
 *   PUT    /accounts/:acct/workers/account-settings                               -> workers:update_account_settings
 *   GET    /accounts/:acct/workers/account-settings                               -> workers:get_account_settings
 *
 * Custom domains:
 *   PUT    /accounts/:acct/workers/domains                                        -> workers:update_domain
 *   GET    /accounts/:acct/workers/domains                                        -> workers:list_domains
 *   DELETE /accounts/:acct/workers/domains/:domainId                              -> workers:delete_domain
 *   GET    /accounts/:acct/workers/domains/:domainId                              -> workers:get_domain
 *
 * Observability:
 *   POST   /accounts/:acct/workers/observability/telemetry/keys                   -> workers:telemetry
 *   POST   /accounts/:acct/workers/observability/telemetry/query                  -> workers:telemetry
 *   POST   /accounts/:acct/workers/observability/telemetry/values                 -> workers:telemetry
 */

import type { RequestContext } from '../../policy-types';

// ─── Workers IAM actions ────────────────────────────────────────────────────

export type WorkersAction =
	// Scripts CRUD
	| 'workers:list_scripts'
	| 'workers:get_script'
	| 'workers:update_script'
	| 'workers:delete_script'
	// Script content
	| 'workers:get_content'
	| 'workers:update_content'
	// Settings
	| 'workers:get_settings'
	| 'workers:update_settings'
	| 'workers:get_script_settings'
	| 'workers:update_script_settings'
	// Versions
	| 'workers:list_versions'
	| 'workers:get_version'
	| 'workers:create_version'
	// Deployments
	| 'workers:list_deployments'
	| 'workers:get_deployment'
	| 'workers:create_deployment'
	| 'workers:delete_deployment'
	// Secrets
	| 'workers:list_secrets'
	| 'workers:get_secret'
	| 'workers:update_secret'
	| 'workers:delete_secret'
	// Schedules
	| 'workers:get_schedules'
	| 'workers:update_schedules'
	// Tails
	| 'workers:list_tails'
	| 'workers:create_tail'
	| 'workers:delete_tail'
	// Script subdomain
	| 'workers:get_subdomain'
	| 'workers:update_subdomain'
	| 'workers:delete_subdomain'
	// Assets upload
	| 'workers:upload_assets'
	// Account subdomain
	| 'workers:get_account_subdomain'
	| 'workers:update_account_subdomain'
	| 'workers:delete_account_subdomain'
	// Account settings
	| 'workers:get_account_settings'
	| 'workers:update_account_settings'
	// Custom domains
	| 'workers:list_domains'
	| 'workers:get_domain'
	| 'workers:update_domain'
	| 'workers:delete_domain'
	// Observability
	| 'workers:telemetry';

// ─── Context builders — account-level (no script name) ──────────────────────

/** Build a RequestContext for listing scripts (GET /workers/scripts). */
export function workersListScriptsContext(accountId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'workers:list_scripts',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for account subdomain operations. */
export function workersAccountSubdomainContext(
	accountId: string,
	action: 'workers:get_account_subdomain' | 'workers:update_account_subdomain' | 'workers:delete_account_subdomain',
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action,
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for account settings operations. */
export function workersAccountSettingsContext(
	accountId: string,
	action: 'workers:get_account_settings' | 'workers:update_account_settings',
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action,
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for custom domain operations. */
export function workersDomainContext(
	accountId: string,
	action: 'workers:list_domains' | 'workers:get_domain' | 'workers:update_domain' | 'workers:delete_domain',
	domainId?: string,
	requestFields?: Record<string, string>,
): RequestContext {
	const fields: Record<string, string | boolean> = { ...(requestFields ?? {}) };
	if (domainId) fields['workers.domain_id'] = domainId;
	return {
		action,
		resource: `account:${accountId}`,
		fields,
	};
}

/** Build a RequestContext for observability/telemetry operations. */
export function workersTelemetryContext(accountId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'workers:telemetry',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

// ─── Context builders — script-scoped ───────────────────────────────────────

/** Build a RequestContext for a script-scoped Workers operation. */
export function workersScriptContext(
	accountId: string,
	scriptName: string,
	action: WorkersAction,
	requestFields?: Record<string, string>,
	extra?: Record<string, string>,
): RequestContext {
	const fields: Record<string, string | boolean> = {
		...(requestFields ?? {}),
		'workers.script_name': scriptName,
	};
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			fields[k] = v;
		}
	}
	return {
		action,
		resource: `account:${accountId}`,
		fields,
	};
}
