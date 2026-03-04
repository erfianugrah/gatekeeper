/** Terminal UI helpers — colors, formatting, tables, spinners */

const isTTY = process.stdout.isTTY ?? false;
const isColorDisabled = !!process.env["NO_COLOR"];
const useColor = isTTY && !isColorDisabled;

// --- ANSI colors (no-op if not TTY or NO_COLOR set) ---

function wrap(code: number, reset: number) {
	return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[${reset}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

// --- Symbols ---

export const symbols = {
	success: useColor ? "\x1b[32m\u2713\x1b[39m" : "[OK]",
	error: useColor ? "\x1b[31m\u2717\x1b[39m" : "[ERR]",
	warn: useColor ? "\x1b[33m!\x1b[39m" : "[!]",
	info: useColor ? "\x1b[34mi\x1b[39m" : "[i]",
	arrow: useColor ? "\x1b[36m>\x1b[39m" : ">",
	bullet: useColor ? "\x1b[90m-\x1b[39m" : "-",
	key: useColor ? "\x1b[33m\u{1F511}\x1b[39m" : "[KEY]",
};

// --- Logging ---

export function success(msg: string): void {
	console.error(`${symbols.success} ${msg}`);
}

export function error(msg: string): void {
	console.error(`${symbols.error} ${red(msg)}`);
}

export function warn(msg: string): void {
	console.error(`${symbols.warn} ${yellow(msg)}`);
}

export function info(msg: string): void {
	console.error(`${symbols.info} ${msg}`);
}

export function label(name: string, value: string): void {
	console.error(`  ${dim(name + ":")} ${value}`);
}

// --- Spinner ---

const spinnerFrames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

export function spinner(msg: string): { stop: (finalMsg?: string) => void } {
	if (!useColor) {
		console.error(`... ${msg}`);
		return {
			stop(finalMsg?: string) {
				if (finalMsg) console.error(finalMsg);
			},
		};
	}
	let i = 0;
	const id = setInterval(() => {
		process.stderr.write(
			`\r${cyan(spinnerFrames[i % spinnerFrames.length])} ${msg}`,
		);
		i++;
	}, 80);
	return {
		stop(finalMsg?: string) {
			clearInterval(id);
			process.stderr.write("\r\x1b[K"); // clear line
			if (finalMsg) console.error(finalMsg);
		},
	};
}

// --- Table ---

export function table(
	headers: string[],
	rows: string[][],
	opts?: { indent?: number },
): void {
	const indent = " ".repeat(opts?.indent ?? 2);
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)),
	);

	const headerLine = headers
		.map((h, i) => bold(h.toUpperCase().padEnd(widths[i])))
		.join("  ");
	console.error(`${indent}${headerLine}`);

	for (const row of rows) {
		const line = row
			.map((cell, i) => {
				const stripped = stripAnsi(cell);
				const pad = widths[i] - stripped.length;
				return cell + " ".repeat(Math.max(0, pad));
			})
			.join("  ");
		console.error(`${indent}${line}`);
	}
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// --- JSON output (stdout for piping, stderr for human info) ---

export function printJson(data: unknown): void {
	console.log(JSON.stringify(data, null, isTTY ? 2 : 0));
}

// --- Error formatting ---

export function formatApiError(status: number, data: unknown): void {
	const d = data as Record<string, unknown> | null;
	const errors = (d?.errors ?? []) as { code?: number; message?: string }[];

	error(`Request failed ${dim(`(HTTP ${status})`)}`);
	if (errors.length > 0) {
		for (const e of errors) {
			console.error(`  ${dim(String(e.code ?? status))} ${e.message ?? "Unknown error"}`);
		}
	}
	if (d?.denied) {
		const denied = d.denied as string[];
		console.error(`  ${dim("Denied scopes:")} ${denied.join(", ")}`);
	}
}

// --- Rate limit formatting ---

export function formatRateLimit(headers: Headers): void {
	const rl = headers.get("Ratelimit");
	if (!rl) return;

	// Parse "purge-bulk";r=499;t=0
	const nameMatch = rl.match(/"([^"]+)"/);
	const rMatch = rl.match(/;r=(\d+)/);
	const tMatch = rl.match(/;t=(\d+)/);
	const name = nameMatch?.[1] ?? "unknown";
	const remaining = Number(rMatch?.[1] ?? 0);
	const nextRefill = Number(tMatch?.[1] ?? 0);

	const policy = headers.get("Ratelimit-Policy") ?? "";
	const qMatch = policy.match(/;q=(\d+)/);
	const wMatch = policy.match(/;w=(\d+)/);
	const capacity = Number(qMatch?.[1] ?? 0);
	const window = Number(wMatch?.[1] ?? 0);

	const retryAfter = headers.get("Retry-After");

	const rate = window > 0 ? Math.round(capacity / window) : 0;
	const used = capacity - remaining;
	const pct = capacity > 0 ? Math.round((remaining / capacity) * 100) : 0;
	const bar = capacity > 0 ? renderBar(pct) : "";

	const pctColor = pct > 50 ? green : pct > 20 ? yellow : red;
	const isBulk = name.includes("bulk");

	console.error("");
	console.error(
		`  ${dim("┌─")} ${bold("Rate Limit")} ${dim("─")} ${cyan(name)} ${dim("─".repeat(Math.max(1, 30 - name.length)))}`,
	);
	console.error(
		`  ${dim("│")} ${bar} ${pctColor(bold(String(pct) + "%"))} remaining`,
	);
	console.error(
		`  ${dim("│")} ${bold(String(remaining))}${dim("/")}${String(capacity)} tokens   ${dim("·")}   ${bold(String(used))} used this session`,
	);
	console.error(
		`  ${dim("│")} Refill: ${bold(String(rate))} ${isBulk ? "req" : "URLs"}${dim("/sec")}${nextRefill > 0 ? `   ${dim("·")}   next refill in ${bold(nextRefill + "s")}` : ""}`,
	);
	if (retryAfter) {
		console.error(
			`  ${dim("│")} ${red(bold("THROTTLED"))} ${dim("·")} retry after ${bold(yellow(retryAfter + "s"))}`,
		);
	}
	console.error(`  ${dim("└" + "─".repeat(45))}`);
}

function renderBar(pct: number): string {
	if (!useColor) return `[${pct}%]`;
	const width = 20;
	const filled = Math.round((pct / 100) * width);
	const empty = width - filled;
	const color = pct > 50 ? green : pct > 20 ? yellow : red;
	return (
		dim("[") +
		color("\u2588".repeat(filled)) +
		dim("\u2591".repeat(empty)) +
		dim("]")
	);
}

// --- Duration formatting ---

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// --- Scope helpers ---

export const SCOPE_TYPES = [
	"host",
	"tag",
	"prefix",
	"url_prefix",
	"purge_everything",
	"*",
] as const;

export const SCOPE_EXAMPLES: Record<string, string> = {
	host: "host:example.com",
	tag: "tag:product-page",
	prefix: "prefix:example.com/blog",
	url_prefix: "url_prefix:https://example.com/assets/",
	purge_everything: "purge_everything:true",
	"*": "*:*",
};

export const SCOPE_DESCRIPTIONS: Record<string, string> = {
	host: "Exact hostname match for bulk host purge",
	tag: "Exact cache tag match for bulk tag purge",
	prefix: "Prefix match for bulk prefix purge (host/path)",
	url_prefix: "URL prefix match for single-file purge (full URL)",
	purge_everything: "Allow purge_everything: true requests",
	"*": "Wildcard -- unrestricted access to all purge types",
};

/**
 * Validate and parse a single scope string like "host:erfi.io".
 * Returns the parsed scope or throws a ScopeError.
 */
export class ScopeError extends Error {
	constructor(
		message: string,
		public readonly kind: "format" | "type",
		public readonly raw: string,
	) {
		super(message);
		this.name = "ScopeError";
	}
}

export function validateScope(raw: string): {
	scope_type: string;
	scope_value: string;
} {
	const trimmed = raw.trim();
	const idx = trimmed.indexOf(":");
	if (idx === -1) {
		throw new ScopeError(
			`Invalid scope: "${trimmed}". Expected "type:value" format.`,
			"format",
			trimmed,
		);
	}

	const scope_type = trimmed.slice(0, idx);
	const scope_value = trimmed.slice(idx + 1);

	if (!SCOPE_TYPES.includes(scope_type as (typeof SCOPE_TYPES)[number])) {
		throw new ScopeError(
			`Unknown scope type: "${scope_type}". Valid types: ${SCOPE_TYPES.join(", ")}`,
			"type",
			trimmed,
		);
	}

	return { scope_type, scope_value };
}

export function parseScopes(
	input: string,
): { scope_type: string; scope_value: string }[] {
	try {
		return input.split(",").map((s) => validateScope(s));
	} catch (err) {
		if (!(err instanceof ScopeError)) throw err;

		if (err.kind === "format") {
			error(`Invalid scope: ${bold(err.raw)}`);
			console.error("");
			console.error(`  Scopes must be in ${bold("type:value")} format.`);
			console.error(`  Separate multiple scopes with commas.`);
			console.error("");
			console.error(`  ${bold("Available scope types:")}`);
			for (const t of SCOPE_TYPES) {
				console.error(
					`    ${cyan(SCOPE_EXAMPLES[t].padEnd(42))} ${dim(SCOPE_DESCRIPTIONS[t])}`,
				);
			}
			console.error("");
			console.error(`  ${bold("Example:")}`);
			console.error(
				`    --scope ${cyan('"host:erfi.io,tag:blog,url_prefix:https://erfi.io/assets/"')}`,
			);
		} else {
			const type = err.raw.slice(0, err.raw.indexOf(":"));
			error(`Unknown scope type: ${bold(type)}`);
			console.error("");
			console.error(`  ${bold("Valid scope types:")}`);
			for (const t of SCOPE_TYPES) {
				console.error(
					`    ${cyan(t.padEnd(20))} ${dim(SCOPE_DESCRIPTIONS[t])}`,
				);
			}
		}
		process.exit(1);
	}
}

// --- Key formatting ---

export function formatKey(key: {
	id: string;
	name: string;
	zone_id: string;
	created_at: number;
	expires_at: number | null;
	revoked: number;
}): void {
	const status =
		key.revoked === 1
			? red("revoked")
			: key.expires_at && key.expires_at < Date.now()
				? red("expired")
				: green("active");

	label("ID", bold(key.id));
	label("Name", key.name);
	label("Zone", key.zone_id);
	label("Status", status);
	label("Created", new Date(key.created_at).toISOString());
	if (key.expires_at) {
		label("Expires", new Date(key.expires_at).toISOString());
	}
}

export function formatScopes(
	scopes: { scope_type: string; scope_value: string }[],
): void {
	if (scopes.length === 0) {
		console.error(`  ${dim("No scopes (key cannot authorize anything)")}`);
		return;
	}
	for (const s of scopes) {
		console.error(`  ${symbols.bullet} ${cyan(s.scope_type)}${dim(":")}${s.scope_value}`);
	}
}
