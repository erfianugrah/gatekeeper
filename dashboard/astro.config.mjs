import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { createLogger } from 'vite';

// ─── Quiet upstream deprecation noise ────────────────────────────────
// @astrojs/react@6 pins @vitejs/plugin-react@^5.2.0, whose `vite:react-babel`
// plugin still passes esbuild-named options (`esbuild`, `optimizeDeps.esbuildOptions`)
// to Vite 8, which now bundles with Rolldown and warns on those legacy names.
// The options are auto-converted by Vite, so the warnings are cosmetic. Filter
// only these two known lines so real warnings still surface. Remove once
// @astrojs/react bumps to plugin-react 6 (Rolldown-native).
const DEPRECATION_NOISE = /`esbuild` option was specified|optimizeDeps\.esbuildOptions/;
const logger = createLogger();
const originalWarn = logger.warn.bind(logger);
const originalWarnOnce = logger.warnOnce.bind(logger);
logger.warn = (msg, options) => {
	if (DEPRECATION_NOISE.test(msg)) return;
	originalWarn(msg, options);
};
logger.warnOnce = (msg, options) => {
	if (DEPRECATION_NOISE.test(msg)) return;
	originalWarnOnce(msg, options);
};

export default defineConfig({
	output: 'static',
	integrations: [react()],
	vite: {
		plugins: [tailwindcss()],
		customLogger: logger,
	},
});
