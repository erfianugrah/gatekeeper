#!/usr/bin/env node
import { defineCommand, runMain } from "citty";

const main = defineCommand({
	meta: {
		name: "purge-gw",
		version: "0.1.0",
		description: "CLI for purge-api-gateway",
	},
	subCommands: {
		health: () => import("./commands/health.js").then((m) => m.default),
		keys: () => import("./commands/keys.js").then((m) => m.default),
		purge: () => import("./commands/purge.js").then((m) => m.default),
		analytics: () => import("./commands/analytics.js").then((m) => m.default),
	},
});

runMain(main);
