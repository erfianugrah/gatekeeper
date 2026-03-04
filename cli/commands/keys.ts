import { defineCommand } from "citty";
import { resolveConfig, resolveZoneId, request, assertOk } from "../client.js";
import {
	success,
	info,
	warn,
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
	formatKey,
	formatScopes,
	parseScopes,
	formatDuration,
	symbols,
} from "../ui.js";

/** Shared args across key commands */
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

// --- keys create ---
const create = defineCommand({
	meta: {
		name: "create",
		description: "Create a new scoped API key",
	},
	args: {
		...globalArgs,
		name: {
			type: "string",
			description: "Human-readable key name",
			required: true,
		},
		scope: {
			type: "string",
			description: 'Scopes as type:value (e.g. "host:erfi.io,tag:blog")',
			required: true,
		},
		"expires-in-days": {
			type: "string",
			description: "Auto-expire after N days",
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);
		const scopes = parseScopes(args.scope);

		const body: Record<string, unknown> = {
			name: args.name,
			zone_id: zoneId,
			scopes,
		};
		if (args["expires-in-days"]) {
			body["expires_in_days"] = Number(args["expires-in-days"]);
		}

		const { status, data, durationMs } = await request(
			config,
			"POST",
			"/admin/keys",
			{ body, auth: "admin", label: "Creating API key..." },
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
		>;
		const key = result.key as Record<string, unknown>;
		const keyScopes = result.scopes as {
			scope_type: string;
			scope_value: string;
		}[];

		console.error("");
		success(`Key created ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error("");
		formatKey(key as Parameters<typeof formatKey>[0]);
		console.error("");
		info("Scopes:");
		formatScopes(keyScopes);
		console.error("");
		console.error(
			`  ${symbols.arrow} Use as: ${cyan(`Authorization: Bearer ${key.id}`)}`,
		);
		console.error("");
	},
});

// --- keys list ---
const list = defineCommand({
	meta: { name: "list", description: "List all API keys for a zone" },
	args: {
		...globalArgs,
		"active-only": {
			type: "boolean",
			description: "Only show active (non-revoked, non-expired) keys",
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);

		const statusFilter = args["active-only"] ? "&status=active" : "";
		const { status, data, durationMs } = await request(
			config,
			"GET",
			`/admin/keys?zone_id=${encodeURIComponent(zoneId)}${statusFilter}`,
			{ auth: "admin", label: "Fetching keys..." },
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
			info(`No keys found for zone ${dim(zoneId)}`);
			return;
		}

		console.error("");
		info(
			`${bold(String(result.length))} key${result.length === 1 ? "" : "s"} found ${dim(`(${formatDuration(durationMs)})`)}`,
		);
		console.error("");

		const rows = result.map((k) => {
			const statusLabel =
				(k.revoked as number) === 1
					? red("revoked")
					: k.expires_at &&
						  (k.expires_at as number) < Date.now()
						? red("expired")
						: green("active");

			const created = new Date(k.created_at as number)
				.toISOString()
				.slice(0, 19)
				.replace("T", " ");

			return [
				cyan(k.id as string),
				k.name as string,
				statusLabel,
				created,
			];
		});

		table(["ID", "Name", "Status", "Created"], rows);
		console.error("");
	},
});

// --- keys get ---
const get = defineCommand({
	meta: { name: "get", description: "Get details and scopes of an API key" },
	args: {
		...globalArgs,
		"key-id": {
			type: "string",
			description: "The API key ID (pgw_...)",
			required: true,
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);

		const { status, data, durationMs } = await request(
			config,
			"GET",
			`/admin/keys/${encodeURIComponent(args["key-id"])}?zone_id=${encodeURIComponent(zoneId)}`,
			{ auth: "admin", label: "Fetching key..." },
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
		>;
		const key = result.key as Parameters<typeof formatKey>[0];
		const scopes = result.scopes as {
			scope_type: string;
			scope_value: string;
		}[];

		console.error("");
		formatKey(key);
		console.error("");
		info("Scopes:");
		formatScopes(scopes);
		console.error("");
	},
});

// --- keys revoke ---
const revoke = defineCommand({
	meta: { name: "revoke", description: "Revoke an API key (irreversible)" },
	args: {
		...globalArgs,
		"key-id": {
			type: "string",
			description: "The API key ID to revoke (pgw_...)",
			required: true,
		},
		force: {
			type: "boolean",
			alias: ["f"],
			description: "Skip confirmation prompt",
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);
		const keyId = args["key-id"];

		if (!args.force && process.stdin.isTTY) {
			warn(
				`You are about to revoke key ${bold(keyId)}. This cannot be undone.`,
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

		const { status, data, durationMs } = await request(
			config,
			"DELETE",
			`/admin/keys/${encodeURIComponent(keyId)}?zone_id=${encodeURIComponent(zoneId)}`,
			{ auth: "admin", label: "Revoking key..." },
		);

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		console.error("");
		success(
			`Key ${bold(keyId)} revoked ${dim(`(${formatDuration(durationMs)})`)}`,
		);
		console.error("");
	},
});

// --- keys (parent) ---
export default defineCommand({
	meta: { name: "keys", description: "Manage API keys" },
	subCommands: { create, list, get, revoke },
});
