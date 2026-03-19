/** Secrets set via `wrangler secret put` — not in wrangler.jsonc vars. */
declare namespace Cloudflare {
	interface Env {
		ADMIN_KEY: string;
		/** Cloudflare Access team name (e.g. "myteam" for myteam.cloudflareaccess.com) */
		CF_ACCESS_TEAM_NAME: string;
		/** Cloudflare Access Application Audience (AUD) tag */
		CF_ACCESS_AUD: string;
		/** OAuth2 / OIDC Client ID. */
		OAUTH_CLIENT_ID?: string;
		/** OAuth2 / OIDC Client Secret (optional for public clients with PKCE). */
		OAUTH_CLIENT_SECRET?: string;
		/** OAuth2 authorization endpoint URL. */
		OAUTH_AUTH_ENDPOINT?: string;
		/** OAuth2 token endpoint URL. */
		OAUTH_TOKEN_ENDPOINT?: string;
		/** Space-separated OAuth2 scopes (default: "openid email profile groups"). */
		OAUTH_SCOPES?: string;
		/** ID token claim name for email (default: "email"). */
		OAUTH_EMAIL_CLAIM?: string;
		/** ID token claim name for groups (default: "groups"). */
		OAUTH_GROUPS_CLAIM?: string;
		/** Comma-separated IdP group names that map to the "admin" role. */
		RBAC_ADMIN_GROUPS?: string;
		/** Comma-separated IdP group names that map to the "operator" role. */
		RBAC_OPERATOR_GROUPS?: string;
		/** Comma-separated IdP group names that map to the "viewer" role. */
		RBAC_VIEWER_GROUPS?: string;
		/** Comma-separated email addresses that map to the "admin" role. */
		RBAC_ADMIN_EMAILS?: string;
		/** Comma-separated email addresses that map to the "operator" role. */
		RBAC_OPERATOR_EMAILS?: string;
		/** Comma-separated email addresses that map to the "viewer" role. */
		RBAC_VIEWER_EMAILS?: string;
		/** Comma-separated email domains (e.g. "cloudflare.com") that map to the "admin" role. */
		RBAC_ADMIN_DOMAINS?: string;
		/** Comma-separated email domains that map to the "operator" role. */
		RBAC_OPERATOR_DOMAINS?: string;
		/** Comma-separated email domains that map to the "viewer" role. */
		RBAC_VIEWER_DOMAINS?: string;
	}
}
