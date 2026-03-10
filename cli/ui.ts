/** Terminal UI helpers — colors, formatting, tables, spinners */

import { readFileSync } from 'node:fs';

const isTTY = process.stdout.isTTY ?? false;
const isColorDisabled = !!process.env['NO_COLOR'];
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
	success: useColor ? '\x1b[32m\u2713\x1b[39m' : '[OK]',
	error: useColor ? '\x1b[31m\u2717\x1b[39m' : '[ERR]',
	warn: useColor ? '\x1b[33m!\x1b[39m' : '[!]',
	info: useColor ? '\x1b[34mi\x1b[39m' : '[i]',
	arrow: useColor ? '\x1b[36m>\x1b[39m' : '>',
	bullet: useColor ? '\x1b[90m-\x1b[39m' : '-',
	key: useColor ? '\x1b[33m\u{1F511}\x1b[39m' : '[KEY]',
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
	console.error(`  ${dim(name + ':')} ${value}`);
}

// --- Spinner ---

const spinnerFrames = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

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
		process.stderr.write(`\r${cyan(spinnerFrames[i % spinnerFrames.length])} ${msg}`);
		i++;
	}, 80);
	return {
		stop(finalMsg?: string) {
			clearInterval(id);
			process.stderr.write('\r\x1b[K'); // clear line
			if (finalMsg) console.error(finalMsg);
		},
	};
}

// --- Table ---

export function table(headers: string[], rows: string[][], opts?: { indent?: number }): void {
	const indent = ' '.repeat(opts?.indent ?? 2);
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)));

	const headerLine = headers.map((h, i) => bold(h.toUpperCase().padEnd(widths[i]))).join('  ');
	console.error(`${indent}${headerLine}`);

	for (const row of rows) {
		const line = row
			.map((cell, i) => {
				const stripped = stripAnsi(cell);
				const pad = widths[i] - stripped.length;
				return cell + ' '.repeat(Math.max(0, pad));
			})
			.join('  ');
		console.error(`${indent}${line}`);
	}
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
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
			console.error(`  ${dim(String(e.code ?? status))} ${e.message ?? 'Unknown error'}`);
		}
	}
	if (d?.denied) {
		const denied = d.denied as string[];
		console.error(`  ${dim('Denied scopes:')} ${denied.join(', ')}`);
	}
}

// --- Rate limit formatting ---

export function formatRateLimit(headers: Headers): void {
	const rl = headers.get('Ratelimit');
	if (!rl) return;

	// Parse "purge-bulk";r=499;t=0
	const nameMatch = rl.match(/"([^"]+)"/);
	const rMatch = rl.match(/;r=(\d+)/);
	const tMatch = rl.match(/;t=(\d+)/);
	const name = nameMatch?.[1] ?? 'unknown';
	const remaining = Number(rMatch?.[1] ?? 0);
	const nextRefill = Number(tMatch?.[1] ?? 0);

	const policy = headers.get('Ratelimit-Policy') ?? '';
	const qMatch = policy.match(/;q=(\d+)/);
	const wMatch = policy.match(/;w=(\d+)/);
	const capacity = Number(qMatch?.[1] ?? 0);
	const window = Number(wMatch?.[1] ?? 0);

	const retryAfter = headers.get('Retry-After');

	const rate = window > 0 ? Math.round(capacity / window) : 0;
	const used = capacity - remaining;
	const pct = capacity > 0 ? Math.round((remaining / capacity) * 100) : 0;
	const bar = capacity > 0 ? renderBar(pct) : '';

	const pctColor = pct > 50 ? green : pct > 20 ? yellow : red;
	const isBulk = name.includes('bulk');

	console.error('');
	console.error(`  ${dim('┌─')} ${bold('Rate Limit')} ${dim('─')} ${cyan(name)} ${dim('─'.repeat(Math.max(1, 30 - name.length)))}`);
	console.error(`  ${dim('│')} ${bar} ${pctColor(bold(String(pct) + '%'))} remaining`);
	console.error(
		`  ${dim('│')} ${bold(String(remaining))}${dim('/')}${String(capacity)} tokens   ${dim('·')}   ${bold(String(used))} used this session`,
	);
	console.error(
		`  ${dim('│')} Refill: ${bold(String(rate))} ${isBulk ? 'req' : 'URLs'}${dim('/sec')}${nextRefill > 0 ? `   ${dim('·')}   next refill in ${bold(nextRefill + 's')}` : ''}`,
	);
	if (retryAfter) {
		console.error(`  ${dim('│')} ${red(bold('THROTTLED'))} ${dim('·')} retry after ${bold(yellow(retryAfter + 's'))}`);
	}
	console.error(`  ${dim('└' + '─'.repeat(45))}`);
}

function renderBar(pct: number): string {
	if (!useColor) return `[${pct}%]`;
	const width = 20;
	const filled = Math.round((pct / 100) * width);
	const empty = width - filled;
	const color = pct > 50 ? green : pct > 20 ? yellow : red;
	return dim('[') + color('\u2588'.repeat(filled)) + dim('\u2591'.repeat(empty)) + dim(']');
}

// --- Duration formatting ---

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// --- Key formatting ---

export function formatKey(key: {
	id: string;
	name: string;
	zone_id: string | null;
	created_at: number;
	expires_at: number | null;
	revoked: number;
	created_by?: string | null;
	upstream_token_id?: string | null;
}): void {
	const status = key.revoked === 1 ? red('revoked') : key.expires_at && key.expires_at < Date.now() ? red('expired') : green('active');

	label('ID', bold(key.id));
	label('Name', key.name);
	label('Zone', key.zone_id ?? dim('any'));
	label('Status', status);
	if (key.upstream_token_id) {
		label('Upstream Token', key.upstream_token_id);
	}
	label('Created', new Date(key.created_at).toISOString());
	if (key.expires_at) {
		label('Expires', new Date(key.expires_at).toISOString());
	}
	if (key.created_by) {
		label('Created by', key.created_by);
	}
}

// --- Policy helpers ---

/** Pretty-print a v2 policy document for terminal display. */
export function formatPolicy(policyJson: string): void {
	let doc: PolicyDoc;
	try {
		doc = JSON.parse(policyJson) as PolicyDoc;
	} catch {
		console.error(`  ${dim('(invalid policy JSON)')}`);
		return;
	}

	console.error(`  ${dim('version:')} ${doc.version ?? 'unknown'}`);
	const stmts = doc.statements ?? [];
	if (stmts.length === 0) {
		console.error(`  ${dim('No statements (key cannot authorize anything)')}`);
		return;
	}

	for (let i = 0; i < stmts.length; i++) {
		const s = stmts[i];
		const effect = s.effect === 'deny' ? red('deny') : green('allow');
		console.error(`  ${dim(`[${i + 1}]`)} ${bold(effect)}`);

		// Actions
		if (s.actions && s.actions.length > 0) {
			console.error(`      ${dim('actions:')} ${s.actions.map((a: string) => cyan(a)).join(dim(', '))}`);
		}

		// Resources
		if (s.resources && s.resources.length > 0) {
			console.error(`      ${dim('resources:')} ${s.resources.map((r: string) => cyan(r)).join(dim(', '))}`);
		}

		// Conditions
		if (s.conditions && s.conditions.length > 0) {
			console.error(`      ${dim('conditions:')}`);
			for (const c of s.conditions) {
				formatCondition(c, 8);
			}
		}
	}
}

interface PolicyDoc {
	version?: string;
	statements?: PolicyStatement[];
}

interface PolicyStatement {
	effect?: string;
	actions?: string[];
	resources?: string[];
	conditions?: PolicyCondition[];
}

interface PolicyCondition {
	field?: string;
	operator?: string;
	value?: unknown;
	any?: PolicyCondition[];
	all?: PolicyCondition[];
	not?: PolicyCondition;
}

function formatCondition(c: PolicyCondition, indent: number): void {
	const pad = ' '.repeat(indent);
	if (c.any) {
		console.error(`${pad}${yellow('any')}${dim(':')}`);
		for (const child of c.any) formatCondition(child, indent + 2);
	} else if (c.all) {
		console.error(`${pad}${yellow('all')}${dim(':')}`);
		for (const child of c.all) formatCondition(child, indent + 2);
	} else if (c.not) {
		console.error(`${pad}${yellow('not')}${dim(':')}`);
		formatCondition(c.not, indent + 2);
	} else {
		const val = typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
		console.error(`${pad}${symbols.bullet} ${cyan(c.field ?? '?')} ${dim(c.operator ?? '?')} ${val}`);
	}
}

/**
 * Parse a --policy argument. Accepts either inline JSON or @path/to/file.json.
 * Returns the parsed policy object.
 */
export function parsePolicy(input: string): unknown {
	let jsonStr: string;

	if (input.startsWith('@')) {
		const filePath = input.slice(1);
		try {
			jsonStr = readFileSync(filePath, 'utf-8');
		} catch (err: any) {
			error(`Cannot read policy file: ${bold(filePath)}`);
			console.error(`  ${dim(err.message)}`);
			process.exit(1);
		}
	} else {
		jsonStr = input;
	}

	try {
		return JSON.parse(jsonStr);
	} catch {
		error('Invalid JSON in --policy argument.');
		console.error('');
		console.error(`  ${bold('Usage:')}`);
		console.error(`    ${dim('Inline:')}  --policy '${cyan('{"version":"2025-01-01","statements":[...]}')}'`);
		console.error(`    ${dim('File:')}    --policy ${cyan('@policy.json')}`);
		process.exit(1);
	}
}

/** Prompt user for y/N confirmation. Returns true if confirmed, false otherwise. Returns false if not TTY (use --force to bypass). */
export async function confirmAction(message: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	warn(message);
	process.stderr.write(`  Continue? [y/N] `);

	return new Promise<boolean>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once('data', (chunk) => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			const char = chunk.toString().trim().toLowerCase();
			process.stderr.write(char + '\n');
			resolve(char === 'y');
		});
	});
}

// ─── Time parsing ───────────────────────────────────────────────────────────

/**
 * Parse a time string: supports ISO 8601 or unix milliseconds/seconds.
 * Exits the process on invalid input.
 */
export function parseTime(input: string): number {
	const asNum = Number(input);
	if (!isNaN(asNum) && asNum > 1_000_000_000_000) {
		return asNum; // already unix ms
	}
	if (!isNaN(asNum) && asNum > 1_000_000_000) {
		return asNum * 1000; // unix seconds -> ms
	}
	const date = new Date(input);
	if (isNaN(date.getTime())) {
		error(`Invalid time format: "${input}". Use ISO 8601 or unix ms.`);
		process.exit(1);
	}
	return date.getTime();
}
