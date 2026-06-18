declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		// Forwarded from the runner by vitest.worker.config.ts; "true" on CI. Used to skip
		// environment-sensitive perf-threshold tests on shared runners.
		CI?: string;
	}
}
