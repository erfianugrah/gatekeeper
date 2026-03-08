#!/usr/bin/env node
import { createRequire } from 'node:module';
import { defineCommand, runMain } from 'citty';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const main = defineCommand({
	meta: {
		name: 'gk',
		version: pkg.version,
		description: 'CLI for gatekeeper — API gateway with IAM',
	},
	subCommands: {
		health: () => import('./commands/health.js').then((m) => m.default),
		keys: () => import('./commands/keys.js').then((m) => m.default),
		purge: () => import('./commands/purge.js').then((m) => m.default),
		analytics: () => import('./commands/analytics.js').then((m) => m.default),
		's3-credentials': () => import('./commands/s3-credentials.js').then((m) => m.default),
		's3-analytics': () => import('./commands/s3-analytics.js').then((m) => m.default),
		'dns-analytics': () => import('./commands/dns-analytics.js').then((m) => m.default),
		'upstream-tokens': () => import('./commands/upstream-tokens.js').then((m) => m.default),
		'upstream-r2': () => import('./commands/upstream-r2.js').then((m) => m.default),
		config: () => import('./commands/config.js').then((m) => m.default),
	},
});

runMain(main);
