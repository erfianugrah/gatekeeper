import { defineCommand } from "citty";
import { resolveConfig, resolveZoneId, request, assertOk } from "../client.js";
import {
	success,
	warn,
	info,
	bold,
	dim,
	cyan,
	green,
	red,
	yellow,
	printJson,
	formatRateLimit,
	formatDuration,
	symbols,
	label,
} from "../ui.js";

/** Shared args for all purge subcommands */
const sharedArgs = {
	endpoint: {
		type: "string" as const,
		description: "Gateway URL ($PURGE_GATEWAY_URL)",
	},
	"api-key": {
		type: "string" as const,
		description: "API key pgw_... ($PURGE_GATEWAY_API_KEY)",
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

function purgePath(zoneId: string) {
	return `/v1/zones/${encodeURIComponent(zoneId)}/purge_cache`;
}

async function doPurge(
	args: Record<string, unknown>,
	body: unknown,
	description: string,
) {
	const config = resolveConfig(
		args as Parameters<typeof resolveConfig>[0],
	);
	const zoneId = resolveZoneId(
		args as Parameters<typeof resolveZoneId>[0],
	);

	const { status, headers, data, durationMs } = await request(
		config,
		"POST",
		purgePath(zoneId),
		{ body, auth: "bearer", label: `Purging ${description}...` },
	);

	if (args.json) {
		assertOk(status, data);
		printJson(data);
		return;
	}

	if (status >= 400) {
		const d = data as Record<string, unknown> | null;
		const errors = (d?.errors ?? []) as {
			code?: number;
			message?: string;
		}[];

		console.error("");
		if (status === 429) {
			warn(
				`Rate limited ${dim(`(HTTP 429, ${formatDuration(durationMs)})`)}`,
			);
		} else {
			console.error(
				`${symbols.error} ${red("Purge failed")} ${dim(`(HTTP ${status}, ${formatDuration(durationMs)})`)}`,
			);
		}
		for (const e of errors) {
			console.error(`  ${dim(String(e.code ?? status))} ${e.message}`);
		}
		if (d?.denied) {
			console.error(
				`  ${dim("Denied:")} ${(d.denied as string[]).join(", ")}`,
			);
		}
		formatRateLimit(headers);
		console.error("");
		process.exit(1);
	}

	const d = data as Record<string, unknown>;
	const result = d.result as Record<string, unknown> | undefined;

	console.error("");
	success(`Purge succeeded ${dim(`(${formatDuration(durationMs)})`)}`);
	label("Zone", zoneId);
	label("Action", description);

	const cfRay = headers.get("cf-ray");
	const auditId = headers.get("cf-auditlog-id");
	if (cfRay) label("CF-Ray", cfRay);
	if (auditId) label("Audit ID", auditId);

	formatRateLimit(headers);
	console.error("");
}

// --- purge hosts ---
const hosts = defineCommand({
	meta: { name: "hosts", description: "Purge by hostname(s)" },
	args: {
		...sharedArgs,
		host: {
			type: "string",
			description: "Comma-separated hostnames (e.g. example.com,www.example.com)",
			required: true,
		},
	},
	async run({ args }) {
		const hostList = args.host.split(",").map((h) => h.trim());
		await doPurge(args, { hosts: hostList }, `hosts: ${hostList.join(", ")}`);
	},
});

// --- purge tags ---
const tags = defineCommand({
	meta: { name: "tags", description: "Purge by cache tag(s)" },
	args: {
		...sharedArgs,
		tag: {
			type: "string",
			description: "Comma-separated cache tags",
			required: true,
		},
	},
	async run({ args }) {
		const tagList = args.tag.split(",").map((t) => t.trim());
		await doPurge(args, { tags: tagList }, `tags: ${tagList.join(", ")}`);
	},
});

// --- purge prefixes ---
const prefixes = defineCommand({
	meta: {
		name: "prefixes",
		description: "Purge by prefix(es) (e.g. example.com/blog)",
	},
	args: {
		...sharedArgs,
		prefix: {
			type: "string",
			description: "Comma-separated prefixes",
			required: true,
		},
	},
	async run({ args }) {
		const prefixList = args.prefix.split(",").map((p) => p.trim());
		await doPurge(
			args,
			{ prefixes: prefixList },
			`prefixes: ${prefixList.join(", ")}`,
		);
	},
});

// --- purge urls ---
const urls = defineCommand({
	meta: {
		name: "urls",
		description: "Purge specific URL(s)",
	},
	args: {
		...sharedArgs,
		url: {
			type: "string",
			description: "Comma-separated full URLs",
			required: true,
		},
	},
	async run({ args }) {
		const urlList = args.url.split(",").map((u) => u.trim());
		const desc =
			urlList.length === 1
				? `url: ${urlList[0]}`
				: `${urlList.length} URLs`;
		await doPurge(args, { files: urlList }, desc);
	},
});

// --- purge everything ---
const everything = defineCommand({
	meta: {
		name: "everything",
		description: "Purge entire zone cache (use with caution)",
	},
	args: {
		...sharedArgs,
		force: {
			type: "boolean",
			alias: ["f"],
			description: "Skip confirmation prompt",
		},
	},
	async run({ args }) {
		if (!args.force && process.stdin.isTTY) {
			const zoneId = resolveZoneId(
				args as Parameters<typeof resolveZoneId>[0],
			);
			console.error("");
			warn(
				`This will purge ${bold("ALL")} cached content for zone ${bold(zoneId)}.`,
			);
			process.stderr.write(`  Continue? [y/N] `);

			const confirmed = await new Promise<boolean>((resolve) => {
				process.stdin.setRawMode?.(true);
				process.stdin.resume();
				process.stdin.once("data", (chunk) => {
					process.stdin.setRawMode?.(false);
					process.stdin.pause();
					const char = chunk.toString().trim().toLowerCase();
					process.stderr.write(char + "\n");
					resolve(char === "y");
				});
			});

			if (!confirmed) {
				info("Aborted.");
				return;
			}
		}

		await doPurge(args, { purge_everything: true }, "everything");
	},
});

// --- purge (parent) ---
export default defineCommand({
	meta: { name: "purge", description: "Purge cache" },
	subCommands: { hosts, tags, prefixes, urls, everything },
});
