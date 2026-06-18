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
					// CI is forwarded so perf.test.ts can skip its latency-threshold assertions on
					// shared CI runners (env-dependent; meaningful only on a known machine).
					bindings: { ADMIN_KEY: "test-admin-secret-key-12345", CI: process.env.CI ?? "" },
				},
			},
		},
	},
});
