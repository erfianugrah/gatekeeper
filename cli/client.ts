/** Shared HTTP client for the gatekeeper CLI */

import { error, formatApiError, spinner, formatDuration } from './ui.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const ADMIN_KEY_HEADER = 'X-Admin-Key';
const CLI_FETCH_TIMEOUT_MS = 30_000;
const ERROR_PREVIEW_MAX_LENGTH = 200;

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ClientConfig {
	baseUrl: string;
	adminKey?: string;
	apiKey?: string;
}

export function resolveConfig(args: { endpoint?: string; 'admin-key'?: string; 'api-key'?: string }): ClientConfig {
	const baseUrl = (args.endpoint || process.env['GATEKEEPER_URL'] || '').replace(/\/+$/, '');
	if (!baseUrl) {
		error('Endpoint required. Set --endpoint or GATEKEEPER_URL.');
		process.exit(1);
	}

	const adminKey = args['admin-key'] || process.env['GATEKEEPER_ADMIN_KEY'];
	const apiKey = args['api-key'] || process.env['GATEKEEPER_API_KEY'];

	return { baseUrl, adminKey, apiKey };
}

export function resolveZoneId(args: { 'zone-id'?: string }): string {
	const zoneId = args['zone-id'] || process.env['GATEKEEPER_ZONE_ID'];
	if (!zoneId) {
		error('Zone ID required. Set --zone-id or GATEKEEPER_ZONE_ID.');
		process.exit(1);
	}
	return zoneId;
}

/** Like resolveZoneId but returns undefined instead of exiting when no zone is set. */
export function resolveOptionalZoneId(args: { 'zone-id'?: string }): string | undefined {
	return args['zone-id'] || process.env['GATEKEEPER_ZONE_ID'] || undefined;
}

export async function request(
	config: ClientConfig,
	method: string,
	path: string,
	opts?: {
		body?: unknown;
		auth?: 'admin' | 'bearer';
		label?: string;
	},
): Promise<{ status: number; headers: Headers; data: unknown; durationMs: number }> {
	const url = `${config.baseUrl}${path}`;
	const headers: Record<string, string> = {};

	if (opts?.body) {
		headers['Content-Type'] = 'application/json';
	}

	if (opts?.auth === 'admin') {
		if (!config.adminKey) {
			error('Admin key required. Set --admin-key or GATEKEEPER_ADMIN_KEY.');
			process.exit(1);
		}
		headers[ADMIN_KEY_HEADER] = config.adminKey;
	} else if (opts?.auth === 'bearer') {
		if (!config.apiKey) {
			error('API key required. Set --api-key or GATEKEEPER_API_KEY.');
			process.exit(1);
		}
		headers['Authorization'] = `Bearer ${config.apiKey}`;
	}

	const spin = spinner(opts?.label ?? `${method} ${path}`);
	const start = performance.now();

	try {
		const res = await fetch(url, {
			method,
			headers,
			body: opts?.body ? JSON.stringify(opts.body) : undefined,
			signal: AbortSignal.timeout(CLI_FETCH_TIMEOUT_MS),
		});

		const durationMs = Math.round(performance.now() - start);
		// Read body as text first to avoid double-consuming the stream
		const raw = await res.text();
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			// Non-JSON response (e.g. HTML error page) — include truncated body in error shape
			const preview = raw.length > ERROR_PREVIEW_MAX_LENGTH ? raw.slice(0, ERROR_PREVIEW_MAX_LENGTH) + '...' : raw;
			data = { success: false, errors: [{ code: res.status, message: preview || `HTTP ${res.status}` }] };
		}
		spin.stop();
		return { status: res.status, headers: res.headers, data, durationMs };
	} catch (err) {
		const durationMs = Math.round(performance.now() - start);
		spin.stop();
		error(`Network error after ${formatDuration(durationMs)}: ${(err as Error).message}`);
		process.exit(1);
	}
}

/** Check response status, print formatted error and exit if not ok */
export function assertOk(status: number, data: unknown, expected = 200): asserts data is Record<string, unknown> {
	if (status !== expected) {
		formatApiError(status, data);
		process.exit(1);
	}
}
