// ─── API Client ──────────────────────────────────────────────────────
// Fetches from the gateway's /admin/* endpoints.
// In development, the Astro dev server proxies to the Worker.
// In production, the dashboard and Worker share the same origin.

export interface ApiKey {
	id: string;
	name: string;
	zone_id: string | null;
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
	effect: 'allow';
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
	purge_type: 'single' | 'bulk';
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
	zone_id?: string;
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
		// Include cookies so the CF_Authorization cookie (Access SSO) is sent
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...adminHeaders(),
			...init?.headers,
		},
	});

	const data: ApiResponse<T> = await res.json();

	if (!data.success || !data.result) {
		const msg = data.errors?.map((e) => e.message).join('; ') ?? 'Unknown error';
		throw new Error(msg);
	}

	return data.result;
}

// ─── Admin auth headers ──────────────────────────────────────────────
// In production, the CF_Authorization cookie (set by Access SSO) handles auth.
// For local dev without Access, an admin key can be set in localStorage.

function adminHeaders(): Record<string, string> {
	const adminKey = typeof window !== 'undefined' ? localStorage.getItem('adminKey') : null;
	if (adminKey) {
		return { 'X-Admin-Key': adminKey };
	}
	return {};
}

// ─── Key management ──────────────────────────────────────────────────

export async function listKeys(zoneId?: string, status?: 'active' | 'revoked'): Promise<ApiKey[]> {
	const params = new URLSearchParams();
	if (zoneId) params.set('zone_id', zoneId);
	if (status) params.set('status', status);
	const qs = params.toString();
	return apiFetch<ApiKey[]>(`/admin/keys${qs ? `?${qs}` : ''}`);
}

export async function getKey(id: string, zoneId?: string): Promise<{ key: ApiKey }> {
	const params = new URLSearchParams();
	if (zoneId) params.set('zone_id', zoneId);
	const qs = params.toString();
	return apiFetch<{ key: ApiKey }>(`/admin/keys/${id}${qs ? `?${qs}` : ''}`);
}

/** Create a key. The key.id (gw_...) IS the Bearer token — there is no separate secret field. */
export async function createKey(req: CreateKeyRequest): Promise<{ key: ApiKey }> {
	return apiFetch<{ key: ApiKey }>('/admin/keys', {
		method: 'POST',
		body: JSON.stringify(req),
	});
}

export async function revokeKey(id: string): Promise<{ revoked: boolean }> {
	return apiFetch<{ revoked: boolean }>(`/admin/keys/${id}`, {
		method: 'DELETE',
	});
}

// ─── Analytics ───────────────────────────────────────────────────────

export interface EventsQuery {
	zone_id?: string;
	key_id?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export async function getEvents(query: EventsQuery = {}): Promise<PurgeEvent[]> {
	const params = new URLSearchParams();
	if (query.zone_id) params.set('zone_id', query.zone_id);
	if (query.key_id) params.set('key_id', query.key_id);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	if (query.limit) params.set('limit', String(query.limit));
	const qs = params.toString();
	return apiFetch<PurgeEvent[]>(`/admin/analytics/events${qs ? `?${qs}` : ''}`);
}

export async function getSummary(query: Omit<EventsQuery, 'limit'> = {}): Promise<AnalyticsSummary> {
	const params = new URLSearchParams();
	if (query.zone_id) params.set('zone_id', query.zone_id);
	if (query.key_id) params.set('key_id', query.key_id);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	const qs = params.toString();
	return apiFetch<AnalyticsSummary>(`/admin/analytics/summary${qs ? `?${qs}` : ''}`);
}

// ─── S3 Credentials ──────────────────────────────────────────────────

export interface S3Credential {
	access_key_id: string;
	secret_access_key: string;
	name: string;
	created_at: number;
	expires_at: number | null;
	revoked: number;
	policy: string;
	created_by: string | null;
}

export interface CreateS3CredentialRequest {
	name: string;
	policy: PolicyDocument;
	expires_in_days?: number;
	created_by?: string;
}

export async function listS3Credentials(status?: 'active' | 'revoked'): Promise<S3Credential[]> {
	const params = new URLSearchParams();
	if (status) params.set('status', status);
	const qs = params.toString();
	return apiFetch<S3Credential[]>(`/admin/s3/credentials${qs ? `?${qs}` : ''}`);
}

export async function getS3Credential(accessKeyId: string): Promise<{ credential: S3Credential }> {
	return apiFetch<{ credential: S3Credential }>(`/admin/s3/credentials/${accessKeyId}`);
}

export async function createS3Credential(req: CreateS3CredentialRequest): Promise<{ credential: S3Credential }> {
	return apiFetch<{ credential: S3Credential }>('/admin/s3/credentials', {
		method: 'POST',
		body: JSON.stringify(req),
	});
}

export async function revokeS3Credential(accessKeyId: string): Promise<{ revoked: boolean }> {
	return apiFetch<{ revoked: boolean }>(`/admin/s3/credentials/${accessKeyId}`, {
		method: 'DELETE',
	});
}

// ─── S3 Analytics ────────────────────────────────────────────────

export interface S3Event {
	id: number;
	credential_id: string;
	operation: string;
	bucket: string | null;
	key: string | null;
	status: number;
	duration_ms: number;
	created_at: number;
}

export interface S3AnalyticsSummary {
	total_requests: number;
	by_status: Record<string, number>;
	by_operation: Record<string, number>;
	by_bucket: Record<string, number>;
	avg_duration_ms: number;
}

export interface S3EventsQuery {
	credential_id?: string;
	bucket?: string;
	operation?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export async function getS3Events(query: S3EventsQuery = {}): Promise<S3Event[]> {
	const params = new URLSearchParams();
	if (query.credential_id) params.set('credential_id', query.credential_id);
	if (query.bucket) params.set('bucket', query.bucket);
	if (query.operation) params.set('operation', query.operation);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	if (query.limit) params.set('limit', String(query.limit));
	const qs = params.toString();
	return apiFetch<S3Event[]>(`/admin/s3/analytics/events${qs ? `?${qs}` : ''}`);
}

export async function getS3Summary(query: Omit<S3EventsQuery, 'limit'> = {}): Promise<S3AnalyticsSummary> {
	const params = new URLSearchParams();
	if (query.credential_id) params.set('credential_id', query.credential_id);
	if (query.bucket) params.set('bucket', query.bucket);
	if (query.operation) params.set('operation', query.operation);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	const qs = params.toString();
	return apiFetch<S3AnalyticsSummary>(`/admin/s3/analytics/summary${qs ? `?${qs}` : ''}`);
}

// ─── Health ──────────────────────────────────────────────────────────

export async function healthCheck(): Promise<{ ok: boolean }> {
	const res = await fetch('/health');
	return res.json();
}
