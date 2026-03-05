/** Secrets set via `wrangler secret put` — not in wrangler.jsonc vars. */
declare namespace Cloudflare {
	interface Env {
		UPSTREAM_API_TOKEN: string;
		ADMIN_KEY: string;
		/** R2 admin credentials for S3 proxy re-signing */
		R2_ACCESS_KEY_ID: string;
		R2_SECRET_ACCESS_KEY: string;
		R2_ENDPOINT: string;
	}
}
