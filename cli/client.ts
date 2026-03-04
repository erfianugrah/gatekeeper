/** Shared HTTP client for the purge-api-gateway CLI */

import { error, formatApiError, spinner, formatDuration } from "./ui.js";

export interface ClientConfig {
	baseUrl: string;
	adminKey?: string;
	apiKey?: string;
}

export function resolveConfig(args: {
	endpoint?: string;
	"admin-key"?: string;
	"api-key"?: string;
}): ClientConfig {
	const baseUrl = (
		args.endpoint ||
		process.env["PURGE_GATEWAY_URL"] ||
		"https://purge.erfi.io"
	).replace(/\/+$/, "");

	const adminKey =
		args["admin-key"] || process.env["PURGE_GATEWAY_ADMIN_KEY"];
	const apiKey = args["api-key"] || process.env["PURGE_GATEWAY_API_KEY"];

	return { baseUrl, adminKey, apiKey };
}

export function resolveZoneId(args: { "zone-id"?: string }): string {
	const zoneId =
		args["zone-id"] || process.env["PURGE_GATEWAY_ZONE_ID"];
	if (!zoneId) {
		error("Zone ID required. Set --zone-id or PURGE_GATEWAY_ZONE_ID.");
		process.exit(1);
	}
	return zoneId;
}

export async function request(
	config: ClientConfig,
	method: string,
	path: string,
	opts?: {
		body?: unknown;
		auth?: "admin" | "bearer";
		label?: string;
	},
): Promise<{ status: number; headers: Headers; data: unknown; durationMs: number }> {
	const url = `${config.baseUrl}${path}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (opts?.auth === "admin") {
		if (!config.adminKey) {
			error(
				"Admin key required. Set --admin-key or PURGE_GATEWAY_ADMIN_KEY.",
			);
			process.exit(1);
		}
		headers["X-Admin-Key"] = config.adminKey;
	} else if (opts?.auth === "bearer") {
		if (!config.apiKey) {
			error(
				"API key required. Set --api-key or PURGE_GATEWAY_API_KEY.",
			);
			process.exit(1);
		}
		headers["Authorization"] = `Bearer ${config.apiKey}`;
	}

	const spin = spinner(opts?.label ?? `${method} ${path}`);
	const start = performance.now();

	try {
		const res = await fetch(url, {
			method,
			headers,
			body: opts?.body ? JSON.stringify(opts.body) : undefined,
		});

		const durationMs = Math.round(performance.now() - start);
		const data = await res.json().catch(() => null);
		spin.stop();
		return { status: res.status, headers: res.headers, data, durationMs };
	} catch (err) {
		const durationMs = Math.round(performance.now() - start);
		spin.stop();
		error(
			`Network error after ${formatDuration(durationMs)}: ${(err as Error).message}`,
		);
		process.exit(1);
	}
}

/** Check response status, print formatted error and exit if not ok */
export function assertOk(
	status: number,
	data: unknown,
	expected = 200,
): asserts data is Record<string, unknown> {
	if (status !== expected) {
		formatApiError(status, data);
		process.exit(1);
	}
}
