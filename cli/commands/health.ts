import { defineCommand } from "citty";
import { resolveConfig, request, assertOk } from "../client.js";
import { success, error, label, formatDuration, dim } from "../ui.js";

export default defineCommand({
	meta: { name: "health", description: "Check if the gateway is reachable" },
	args: {
		endpoint: {
			type: "string",
			description: "Gateway URL ($PURGE_GATEWAY_URL)",
		},
		json: {
			type: "boolean",
			description: "Output raw JSON",
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const { status, data, durationMs } = await request(
			config,
			"GET",
			"/health",
			{ label: "Checking gateway health..." },
		);

		if (args.json) {
			assertOk(status, data);
			console.log(JSON.stringify(data, null, 2));
			return;
		}

		if (status === 200) {
			success(`Gateway is healthy ${dim(`(${formatDuration(durationMs)})`)}`);
			label("Endpoint", config.baseUrl);
		} else {
			error(`Gateway returned HTTP ${status} ${dim(`(${formatDuration(durationMs)})`)}`);
			process.exit(1);
		}
	},
});
