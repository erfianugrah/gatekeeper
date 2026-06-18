import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		name: 'cli',
		include: ['cli/**/*.test.ts'],
		// Cold dynamic imports (await import('./bulk-helpers.js')) can exceed the
		// 5s default on a loaded CI runner — give ample headroom so a tag deploy
		// never gates on transpile latency rather than a real failure.
		testTimeout: 20000,
	},
});
