/** Secrets set via `wrangler secret put` — not in wrangler.jsonc vars. */
declare namespace Cloudflare {
	interface Env {
		UPSTREAM_API_TOKEN: string;
		ADMIN_KEY: string;
	}
}
