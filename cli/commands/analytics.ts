import { defineCommand } from "citty";
import { resolveConfig, resolveZoneId, request, assertOk } from "../client.js";
import {
	success,
	info,
	bold,
	dim,
	cyan,
	green,
	red,
	yellow,
	gray,
	table,
	label,
	printJson,
	formatDuration,
	symbols,
} from "../ui.js";

/** Shared args across analytics commands */
const globalArgs = {
	endpoint: {
		type: "string" as const,
		description: "Gateway URL ($PURGE_GATEWAY_URL)",
	},
	"admin-key": {
		type: "string" as const,
		description: "Admin key ($PURGE_GATEWAY_ADMIN_KEY)",
	},
	"zone-id": {
		type: "string" as const,
		alias: ["z"] as string[],
		description: "Cloudflare zone ID ($PURGE_GATEWAY_ZONE_ID)",
	},
	json: {
		type: "boolean" as const,
		description: "Output raw JSON",
	},
};

// --- analytics events ---
const events = defineCommand({
	meta: {
		name: "events",
		description: "Query recent purge events",
	},
	args: {
		...globalArgs,
		"key-id": {
			type: "string",
			description: "Filter by API key ID",
		},
		since: {
			type: "string",
			description: "Start time (ISO 8601 or unix ms)",
		},
		until: {
			type: "string",
			description: "End time (ISO 8601 or unix ms)",
		},
		limit: {
			type: "string",
			description: "Max events to return (default 100, max 1000)",
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);

		const params = new URLSearchParams({ zone_id: zoneId });
		if (args["key-id"]) params.set("key_id", args["key-id"]);
		if (args.since) params.set("since", String(parseTime(args.since)));
		if (args.until) params.set("until", String(parseTime(args.until)));
		if (args.limit) params.set("limit", args.limit);

		const { status, data, durationMs } = await request(
			config,
			"GET",
			`/admin/analytics/events?${params}`,
			{ auth: "admin", label: "Fetching events..." },
		);

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<
			string,
			unknown
		>[];

		if (result.length === 0) {
			info(`No events found ${dim(`(${formatDuration(durationMs)})`)}`);
			return;
		}

		console.error("");
		info(
			`${bold(String(result.length))} event${result.length === 1 ? "" : "s"} ${dim(`(${formatDuration(durationMs)})`)}`,
		);
		console.error("");

		const rows = result.map((e) => {
			const statusCode = e.status as number;
			const statusColor = statusCode >= 400 ? red : statusCode >= 300 ? yellow : green;
			const collapsed = e.collapsed ? cyan(String(e.collapsed)) : dim("-");
			const ts = new Date(e.created_at as number)
				.toISOString()
				.slice(0, 19)
				.replace("T", " ");
			const keyShort = (e.key_id as string).slice(0, 16) + "...";

			return [
				ts,
				statusColor(String(statusCode)),
				e.purge_type as string,
				String(e.cost),
				collapsed,
				dim(String(e.duration_ms) + "ms"),
				gray(keyShort),
			];
		});

		table(
			["Time", "Status", "Type", "Cost", "Collapsed", "Duration", "Key"],
			rows,
		);
		console.error("");
	},
});

// --- analytics summary ---
const summary = defineCommand({
	meta: {
		name: "summary",
		description: "Get aggregated analytics summary for a zone",
	},
	args: {
		...globalArgs,
		"key-id": {
			type: "string",
			description: "Filter by API key ID",
		},
		since: {
			type: "string",
			description: "Start time (ISO 8601 or unix ms)",
		},
		until: {
			type: "string",
			description: "End time (ISO 8601 or unix ms)",
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);

		const params = new URLSearchParams({ zone_id: zoneId });
		if (args["key-id"]) params.set("key_id", args["key-id"]);
		if (args.since) params.set("since", String(parseTime(args.since)));
		if (args.until) params.set("until", String(parseTime(args.until)));

		const { status, data, durationMs } = await request(
			config,
			"GET",
			`/admin/analytics/summary?${params}`,
			{ auth: "admin", label: "Fetching summary..." },
		);

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const s = (data as Record<string, unknown>).result as Record<
			string,
			unknown
		>;

		console.error("");
		success(`Analytics summary ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error("");

		label("Total requests", bold(String(s.total_requests)));
		label("Total cost", bold(String(s.total_cost)));
		label("Collapsed", bold(String(s.collapsed_count)));
		label("Avg duration", bold(String(s.avg_duration_ms) + "ms"));

		// Status breakdown
		const byStatus = s.by_status as Record<string, number>;
		if (Object.keys(byStatus).length > 0) {
			console.error("");
			info("By status:");
			for (const [code, count] of Object.entries(byStatus)) {
				const color = Number(code) >= 400 ? red : Number(code) >= 300 ? yellow : green;
				console.error(`  ${symbols.bullet} ${color(bold(code))} ${dim("x")}${count}`);
			}
		}

		// Purge type breakdown
		const byType = s.by_purge_type as Record<string, number>;
		if (Object.keys(byType).length > 0) {
			console.error("");
			info("By purge type:");
			for (const [type, count] of Object.entries(byType)) {
				console.error(`  ${symbols.bullet} ${cyan(type)} ${dim("x")}${count}`);
			}
		}

		console.error("");
	},
});

// --- Helper ---

/**
 * Parse a time string: supports ISO 8601 or unix milliseconds.
 */
function parseTime(input: string): number {
	const asNum = Number(input);
	if (!isNaN(asNum) && asNum > 1_000_000_000_000) {
		return asNum; // already unix ms
	}
	if (!isNaN(asNum) && asNum > 1_000_000_000) {
		return asNum * 1000; // unix seconds -> ms
	}
	const date = new Date(input);
	if (isNaN(date.getTime())) {
		console.error(`Invalid time format: "${input}". Use ISO 8601 or unix ms.`);
		process.exit(1);
	}
	return date.getTime();
}

// --- analytics (parent) ---
export default defineCommand({
	meta: { name: "analytics", description: "View purge analytics" },
	subCommands: { events, summary },
});
