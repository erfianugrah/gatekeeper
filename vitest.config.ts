import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			// Worker tests — run in Cloudflare Workers runtime
			"vitest.worker.config.ts",
			// CLI tests — run in Node.js
			"vitest.cli.config.ts",
		],
	},
});
