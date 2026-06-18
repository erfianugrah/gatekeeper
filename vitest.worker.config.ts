import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		name: "worker",
		include: ["test/**/*.test.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				// Hermetic test secrets. Tests authenticate with this exact key (see test/helpers.ts);
				// defining it here means the suite never depends on a gitignored .dev.vars (which CI lacks).
				miniflare: {
					bindings: { ADMIN_KEY: "test-admin-secret-key-12345" },
				},
			},
		},
	},
});
