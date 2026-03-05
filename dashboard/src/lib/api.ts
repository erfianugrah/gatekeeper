// ─── API Client ──────────────────────────────────────────────────────
// Fetches from the gateway's /admin/* endpoints.
// In development, the Astro dev server proxies to the Worker.
// In production, the dashboard and Worker share the same origin.

export interface ApiKey {
	id: string;
	name: string;
	zone_id: string;
	created_at: number;
	expires_at: number | null;
	revoked: number;
	policy: string;
	created_by: string | null;
	bulk_rate: number | null;
	bulk_bucket: number | null;
	single_rate: number | null;
	single_bucket: number | null;
}

export interface CachedKey {
	key: ApiKey;
	resolvedPolicy: PolicyDocument;
	cachedAt: number;
}

export interface PolicyDocument {
	version: string;
	statements: Statement[];
}

export interface Statement {
	effect: "allow";
	actions: string[];
	resources: string[];
	conditions?: Condition[];
}

export type Condition = LeafCondition | AnyCondition | AllCondition | NotCondition;

export interface LeafCondition {
	field: string;
	operator: string;
	value: string | string[] | boolean;
}

export interface AnyCondition {
	any: Condition[];
}

export interface AllCondition {
	all: Condition[];
}

export interface NotCondition {
	not: Condition;
}

export interface PurgeEvent {
	id: number;
	key_id: string;
	zone_id: string;
	purge_type: "single" | "bulk";
	cost: number;
	status: number;
	collapsed: string | null;
	upstream_status: number | null;
	duration_ms: number;
	created_at: number;
}

export interface AnalyticsSummary {
	total_requests: number;
	total_urls_purged: number;
	by_status: Record<string, number>;
	by_purge_type: Record<string, number>;
	collapsed_count: number;
	avg_duration_ms: number;
}

export interface CreateKeyRequest {
	name: string;
	zone_id: string;
	policy: PolicyDocument;
	expires_in_days?: number;
	rate_limit?: {
		bulk_rate?: number;
		bulk_bucket?: number;
		single_rate?: number;
		single_bucket?: number;
	};
}

// ─── Envelope types ──────────────────────────────────────────────────

interface ApiResponse<T> {
	success: boolean;
	result?: T;
	errors?: Array<{ code: number; message: string }>;
}

// ─── Fetch helper ────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...init?.headers,
		},
	});

	const data: ApiResponse<T> = await res.json();

	if (!data.success || !data.result) {
		const msg = data.errors?.map((e) => e.message).join("; ") ?? "Unknown error";
		throw new Error(msg);
	}

	return data.result;
}

// ─── Admin key header ────────────────────────────────────────────────
// In the dashboard, the admin key is passed via a cookie or header
// set by Cloudflare Access. For local dev, we read from a config.

function adminHeaders(): Record<string, string> {
	// Access JWT is sent automatically via cookie.
	// For dev without Access, the admin key can be set in localStorage.
	const adminKey = typeof window !== "undefined" ? localStorage.getItem("adminKey") : null;
	if (adminKey) {
		return { "X-Admin-Key": adminKey };
	}
	return {};
}

// ─── Key management ──────────────────────────────────────────────────

export async function listKeys(zoneId: string, status?: "active" | "revoked"): Promise<ApiKey[]> {
	const params = new URLSearchParams({ zone_id: zoneId });
	if (status) params.set("status", status);
	return apiFetch<ApiKey[]>(`/admin/keys?${params}`, { headers: adminHeaders() });
}

export async function getKey(id: string, zoneId: string): Promise<{ key: ApiKey }> {
	const params = new URLSearchParams({ zone_id: zoneId });
	return apiFetch<{ key: ApiKey }>(`/admin/keys/${id}?${params}`, { headers: adminHeaders() });
}

/** Create a key. The key.id (gw_...) IS the Bearer token — there is no separate secret field. */
export async function createKey(req: CreateKeyRequest): Promise<{ key: ApiKey }> {
	return apiFetch<{ key: ApiKey }>("/admin/keys", {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify(req),
	});
}

export async function revokeKey(id: string, zoneId: string): Promise<{ revoked: boolean }> {
	const params = new URLSearchParams({ zone_id: zoneId });
	return apiFetch<{ revoked: boolean }>(`/admin/keys/${id}?${params}`, {
		method: "DELETE",
		headers: adminHeaders(),
	});
}

// ─── Analytics ───────────────────────────────────────────────────────

export interface EventsQuery {
	zone_id: string;
	key_id?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export async function getEvents(query: EventsQuery): Promise<PurgeEvent[]> {
	const params = new URLSearchParams({ zone_id: query.zone_id });
	if (query.key_id) params.set("key_id", query.key_id);
	if (query.since) params.set("since", String(query.since));
	if (query.until) params.set("until", String(query.until));
	if (query.limit) params.set("limit", String(query.limit));
	return apiFetch<PurgeEvent[]>(`/admin/analytics/events?${params}`, { headers: adminHeaders() });
}

export async function getSummary(query: Omit<EventsQuery, "limit">): Promise<AnalyticsSummary> {
	const params = new URLSearchParams({ zone_id: query.zone_id });
	if (query.key_id) params.set("key_id", query.key_id);
	if (query.since) params.set("since", String(query.since));
	if (query.until) params.set("until", String(query.until));
	return apiFetch<AnalyticsSummary>(`/admin/analytics/summary?${params}`, { headers: adminHeaders() });
}

// ─── Health ──────────────────────────────────────────────────────────

export async function healthCheck(): Promise<{ ok: boolean }> {
	const res = await fetch("/health");
	return res.json();
}
