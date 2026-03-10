// ─── API Client ──────────────────────────────────────────────────────
// Fetches from the gateway's /admin/* endpoints.
// In development, the Astro dev server proxies to the Worker.
// In production, the dashboard and Worker share the same origin.

// ─── Constants ──────────────────────────────────────────────────────

/** Policy document version — must match the worker's POLICY_VERSION. */
export const POLICY_VERSION = '2025-01-01';

const ADMIN_KEY_HEADER = 'X-Admin-Key';

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
	/** Client-side ID for stable React keys — not sent to the API. */
	_id?: string;
	effect: 'allow' | 'deny';
	actions: string[];
	resources: string[];
	conditions?: Condition[];
}

export type Condition = LeafCondition | AnyCondition | AllCondition | NotCondition;

export interface LeafCondition {
	/** Client-side ID for stable React keys — not sent to the API. */
	_id?: string;
	field: string;
	operator: string;
	value: string | string[] | boolean;
}

export interface AnyCondition {
	/** Client-side ID for stable React keys — not sent to the API. */
	_id?: string;
	any: Condition[];
}

export interface AllCondition {
	/** Client-side ID for stable React keys — not sent to the API. */
	_id?: string;
	all: Condition[];
}

export interface NotCondition {
	/** Client-side ID for stable React keys — not sent to the API. */
	_id?: string;
	not: Condition;
}

export interface PurgeEvent {
	id: number;
	key_id: string;
	zone_id: string;
	purge_type: string;
	/** Human-readable summary of the purge target — hosts, URLs, tags, prefixes, or "*". */
	purge_target: string | null;
	/** Rate-limit tokens consumed. For url purges: number of URLs. For bulk types: 1. */
	tokens: number;
	status: number;
	collapsed: string | null;
	upstream_status: number | null;
	duration_ms: number;
	response_detail: string | null;
	created_by: string | null;
	/** Links a leader to its collapsed followers — all share the same flight_id. */
	flight_id: string | null;
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
	upstream_token_id: string;
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
		return { [ADMIN_KEY_HEADER]: adminKey };
	}
	return {};
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Strip client-only _id fields from a policy before sending to the API. */
function stripIds(policy: PolicyDocument): PolicyDocument {
	return {
		version: policy.version,
		statements: policy.statements.map((s) => {
			const { _id, ...rest } = s;
			return {
				...rest,
				conditions: rest.conditions?.map(stripConditionId),
			};
		}),
	};
}

function stripConditionId(c: Condition): Condition {
	const { _id, ...rest } = c as any;
	if ('any' in rest) return { any: rest.any.map(stripConditionId) };
	if ('all' in rest) return { all: rest.all.map(stripConditionId) };
	if ('not' in rest) return { not: stripConditionId(rest.not) };
	return rest;
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
		body: JSON.stringify({ ...req, policy: stripIds(req.policy) }),
	});
}

export async function revokeKey(id: string): Promise<{ revoked: boolean }> {
	return apiFetch<{ revoked: boolean }>(`/admin/keys/${id}`, {
		method: 'DELETE',
	});
}

export async function deleteKey(id: string): Promise<{ deleted: boolean }> {
	return apiFetch<{ deleted: boolean }>(`/admin/keys/${id}?permanent=true`, {
		method: 'DELETE',
	});
}

export interface BulkItemResult {
	id: string;
	status: string;
}

export interface BulkResult {
	processed: number;
	results: BulkItemResult[];
}

export interface BulkDryRunItem {
	id: string;
	current_status: string;
	would_become: string;
}

export interface BulkDryRunResult {
	dry_run: true;
	would_process: number;
	items: BulkDryRunItem[];
}

export async function bulkRevokeKeys(ids: string[]): Promise<BulkResult> {
	return apiFetch<BulkResult>('/admin/keys/bulk-revoke', {
		method: 'POST',
		body: JSON.stringify({ ids, confirm_count: ids.length }),
	});
}

export async function bulkDeleteKeys(ids: string[]): Promise<BulkResult> {
	return apiFetch<BulkResult>('/admin/keys/bulk-delete', {
		method: 'POST',
		body: JSON.stringify({ ids, confirm_count: ids.length }),
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
	upstream_token_id: string;
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
		body: JSON.stringify({ ...req, policy: stripIds(req.policy) }),
	});
}

export async function revokeS3Credential(accessKeyId: string): Promise<{ revoked: boolean }> {
	return apiFetch<{ revoked: boolean }>(`/admin/s3/credentials/${accessKeyId}`, {
		method: 'DELETE',
	});
}

export async function deleteS3Credential(accessKeyId: string): Promise<{ deleted: boolean }> {
	return apiFetch<{ deleted: boolean }>(`/admin/s3/credentials/${accessKeyId}?permanent=true`, {
		method: 'DELETE',
	});
}

export async function bulkRevokeS3Credentials(accessKeyIds: string[]): Promise<BulkResult> {
	return apiFetch<BulkResult>('/admin/s3/credentials/bulk-revoke', {
		method: 'POST',
		body: JSON.stringify({ access_key_ids: accessKeyIds, confirm_count: accessKeyIds.length }),
	});
}

export async function bulkDeleteS3Credentials(accessKeyIds: string[]): Promise<BulkResult> {
	return apiFetch<BulkResult>('/admin/s3/credentials/bulk-delete', {
		method: 'POST',
		body: JSON.stringify({ access_key_ids: accessKeyIds, confirm_count: accessKeyIds.length }),
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
	response_detail: string | null;
	created_by: string | null;
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

// ─── Upstream Tokens ─────────────────────────────────────────────────

export interface UpstreamToken {
	id: string;
	name: string;
	scope_type: 'zone' | 'account';
	/** Comma-separated zone IDs or account ID (depending on scope_type), or "*" for all. */
	zone_ids: string;
	token_preview: string;
	created_at: number;
	created_by: string | null;
}

export interface CreateUpstreamTokenRequest {
	name: string;
	token: string;
	zone_ids: string[];
	created_by?: string;
}

export async function listUpstreamTokens(): Promise<UpstreamToken[]> {
	return apiFetch<UpstreamToken[]>('/admin/upstream-tokens');
}

export async function getUpstreamToken(id: string): Promise<UpstreamToken> {
	return apiFetch<UpstreamToken>(`/admin/upstream-tokens/${id}`);
}

export async function createUpstreamToken(req: CreateUpstreamTokenRequest): Promise<UpstreamToken> {
	return apiFetch<UpstreamToken>('/admin/upstream-tokens', {
		method: 'POST',
		body: JSON.stringify(req),
	});
}

export async function deleteUpstreamToken(id: string): Promise<{ deleted: boolean }> {
	return apiFetch<{ deleted: boolean }>(`/admin/upstream-tokens/${id}`, {
		method: 'DELETE',
	});
}

export async function bulkDeleteUpstreamTokens(ids: string[]): Promise<BulkResult> {
	return apiFetch<BulkResult>('/admin/upstream-tokens/bulk-delete', {
		method: 'POST',
		body: JSON.stringify({ ids, confirm_count: ids.length }),
	});
}

// ─── Upstream R2 Endpoints ───────────────────────────────────────────

export interface UpstreamR2 {
	id: string;
	name: string;
	/** Comma-separated bucket names, or "*" for all buckets. */
	bucket_names: string;
	access_key_preview: string;
	endpoint: string;
	created_at: number;
	created_by: string | null;
}

export interface CreateUpstreamR2Request {
	name: string;
	access_key_id: string;
	secret_access_key: string;
	endpoint: string;
	bucket_names: string[];
	created_by?: string;
}

export async function listUpstreamR2(): Promise<UpstreamR2[]> {
	return apiFetch<UpstreamR2[]>('/admin/upstream-r2');
}

export async function getUpstreamR2(id: string): Promise<UpstreamR2> {
	return apiFetch<UpstreamR2>(`/admin/upstream-r2/${id}`);
}

export async function createUpstreamR2(req: CreateUpstreamR2Request): Promise<UpstreamR2> {
	return apiFetch<UpstreamR2>('/admin/upstream-r2', {
		method: 'POST',
		body: JSON.stringify(req),
	});
}

export async function deleteUpstreamR2(id: string): Promise<{ deleted: boolean }> {
	return apiFetch<{ deleted: boolean }>(`/admin/upstream-r2/${id}`, {
		method: 'DELETE',
	});
}

export async function bulkDeleteUpstreamR2Endpoints(ids: string[]): Promise<BulkResult> {
	return apiFetch<BulkResult>('/admin/upstream-r2/bulk-delete', {
		method: 'POST',
		body: JSON.stringify({ ids, confirm_count: ids.length }),
	});
}

// ─── DNS Analytics ───────────────────────────────────────────────────

export interface DnsEvent {
	id: number;
	key_id: string;
	zone_id: string;
	action: string;
	record_name: string | null;
	record_type: string | null;
	status: number;
	upstream_status: number | null;
	duration_ms: number;
	created_at: number;
	response_detail: string | null;
	created_by: string | null;
}

export interface DnsAnalyticsSummary {
	total_requests: number;
	by_status: Record<string, number>;
	by_action: Record<string, number>;
	by_record_type: Record<string, number>;
	avg_duration_ms: number;
}

export interface DnsEventsQuery {
	zone_id?: string;
	key_id?: string;
	action?: string;
	record_type?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export async function getDnsEvents(query: DnsEventsQuery = {}): Promise<DnsEvent[]> {
	const params = new URLSearchParams();
	if (query.zone_id) params.set('zone_id', query.zone_id);
	if (query.key_id) params.set('key_id', query.key_id);
	if (query.action) params.set('action', query.action);
	if (query.record_type) params.set('record_type', query.record_type);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	if (query.limit) params.set('limit', String(query.limit));
	const qs = params.toString();
	return apiFetch<DnsEvent[]>(`/admin/dns/analytics/events${qs ? `?${qs}` : ''}`);
}

export async function getDnsSummary(query: Omit<DnsEventsQuery, 'limit'> = {}): Promise<DnsAnalyticsSummary> {
	const params = new URLSearchParams();
	if (query.zone_id) params.set('zone_id', query.zone_id);
	if (query.key_id) params.set('key_id', query.key_id);
	if (query.action) params.set('action', query.action);
	if (query.record_type) params.set('record_type', query.record_type);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	const qs = params.toString();
	return apiFetch<DnsAnalyticsSummary>(`/admin/dns/analytics/summary${qs ? `?${qs}` : ''}`);
}

// ─── CF Proxy Analytics ──────────────────────────────────────────────

export interface CfProxyEvent {
	id: number;
	key_id: string;
	account_id: string;
	service: string;
	action: string;
	resource_id: string | null;
	status: number;
	upstream_status: number | null;
	duration_ms: number;
	upstream_latency_ms: number | null;
	response_size: number | null;
	response_detail: string | null;
	created_by: string | null;
	created_at: number;
}

export interface CfProxyAnalyticsSummary {
	total_requests: number;
	by_status: Record<string, number>;
	by_service: Record<string, number>;
	by_action: Record<string, number>;
	avg_duration_ms: number;
	avg_upstream_latency_ms: number;
	avg_response_size: number;
}

export interface CfProxyEventsQuery {
	account_id?: string;
	key_id?: string;
	service?: string;
	action?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export async function getCfProxyEvents(query: CfProxyEventsQuery = {}): Promise<CfProxyEvent[]> {
	const params = new URLSearchParams();
	if (query.account_id) params.set('account_id', query.account_id);
	if (query.key_id) params.set('key_id', query.key_id);
	if (query.service) params.set('service', query.service);
	if (query.action) params.set('action', query.action);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	if (query.limit) params.set('limit', String(query.limit));
	const qs = params.toString();
	return apiFetch<CfProxyEvent[]>(`/admin/cf/analytics/events${qs ? `?${qs}` : ''}`);
}

export async function getCfProxySummary(query: Omit<CfProxyEventsQuery, 'limit'> = {}): Promise<CfProxyAnalyticsSummary> {
	const params = new URLSearchParams();
	if (query.account_id) params.set('account_id', query.account_id);
	if (query.key_id) params.set('key_id', query.key_id);
	if (query.service) params.set('service', query.service);
	if (query.action) params.set('action', query.action);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	const qs = params.toString();
	return apiFetch<CfProxyAnalyticsSummary>(`/admin/cf/analytics/summary${qs ? `?${qs}` : ''}`);
}

// ─── Config Registry ─────────────────────────────────────────────────

export interface GatewayConfig {
	bulk_rate: number;
	bulk_bucket_size: number;
	bulk_max_ops: number;
	single_rate: number;
	single_bucket_size: number;
	single_max_ops: number;
	key_cache_ttl_ms: number;
	retention_days: number;
	/** S3 proxy: account-level requests per second. */
	s3_rps: number;
	/** S3 proxy: account-level burst capacity. */
	s3_burst: number;
	/** CF API proxy: account-level requests per second. */
	cf_proxy_rps: number;
	/** CF API proxy: account-level burst capacity. */
	cf_proxy_burst: number;
}

export interface ConfigOverride {
	key: string;
	value: string;
	updated_at: number;
	updated_by: string | null;
}

export interface ConfigResponse {
	config: GatewayConfig;
	overrides: ConfigOverride[];
	defaults: Record<string, number>;
}

export async function getConfig(): Promise<ConfigResponse> {
	return apiFetch<ConfigResponse>('/admin/config');
}

export async function setConfig(updates: Record<string, number>): Promise<{ config: GatewayConfig }> {
	return apiFetch<{ config: GatewayConfig }>('/admin/config', {
		method: 'PUT',
		body: JSON.stringify(updates),
	});
}

export async function resetConfigKey(key: string): Promise<{ config: GatewayConfig }> {
	return apiFetch<{ config: GatewayConfig }>(`/admin/config/${key}`, {
		method: 'DELETE',
	});
}

// ─── Identity / Session ──────────────────────────────────────────────

export interface MeResponse {
	email: string | null;
	role: string;
	groups: string[];
	authMethod: 'access' | 'api-key';
	logoutUrl: string | null;
}

export async function getMe(): Promise<MeResponse> {
	return apiFetch<MeResponse>('/admin/me');
}

// ─── Health ──────────────────────────────────────────────────────────

export async function healthCheck(): Promise<{ ok: boolean }> {
	const res = await fetch('/health');
	return res.json();
}
