import type { PurgeEvent, S3Event, DnsEvent, CfProxyEvent } from '@/lib/api';

// ─── Unified event type ─────────────────────────────────────────────

/** Known sources for display. CF proxy events use their service name directly (d1, kv, workers, etc.). */
export type KnownSource = 'purge' | 's3' | 'dns' | 'd1' | 'kv' | 'workers' | 'queues' | 'vectorize' | 'hyperdrive';

export type UnifiedEvent = {
	id: number;
	source: string;
	status: number;
	duration_ms: number;
	created_at: number;
	raw: PurgeEvent | S3Event | DnsEvent | CfProxyEvent;
	key_id?: string;
	zone_id?: string;
	purge_type?: string;
	purge_target?: string | null;
	tokens?: number;
	collapsed?: string | null;
	upstream_status?: number | null;
	flight_id?: string | null;
	credential_id?: string;
	operation?: string;
	bucket?: string | null;
	s3_key?: string | null;
	dns_action?: string;
	dns_name?: string | null;
	dns_type?: string | null;
	cf_service?: string;
	cf_action?: string;
	cf_account_id?: string;
	cf_resource_id?: string | null;
};

/** A flight group: one leader event with zero or more collapsed followers. */
export interface FlightGroup {
	/** The leader event (collapsed=null) or the first event if no clear leader. */
	leader: UnifiedEvent;
	/** Collapsed followers that piggy-backed on this flight. */
	followers: UnifiedEvent[];
	/** Sort key — use the leader's created_at for ordering. */
	sortKey: number;
}

// ─── Sort & filter types ────────────────────────────────────────────

export type SortField = 'created_at' | 'status' | 'duration_ms' | 'source';
export type SortDir = 'asc' | 'desc';
/** Tab filter is 'all' or any source string found in the data. */
export type TabFilter = string;
export type StatusFilter = 'all' | '2xx' | '4xx' | '5xx';

// ─── Constants ──────────────────────────────────────────────────────

/** Offset to avoid ID collisions between purge events and S3 events in the unified view. */
export const S3_EVENT_ID_OFFSET = 1_000_000_000;

/** Offset to avoid ID collisions between purge/S3 events and DNS events in the unified view. */
export const DNS_EVENT_ID_OFFSET = 2_000_000_000;

/** Offset to avoid ID collisions for CF proxy events in the unified view. */
export const CF_EVENT_ID_OFFSET = 3_000_000_000;

export const LIMIT_OPTIONS = [50, 100, 500] as const;

// ─── Conversion functions ───────────────────────────────────────────

export function fromPurge(ev: PurgeEvent): UnifiedEvent {
	return {
		id: ev.id,
		source: 'purge',
		status: ev.status,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		raw: ev,
		key_id: ev.key_id,
		zone_id: ev.zone_id,
		purge_type: ev.purge_type,
		purge_target: ev.purge_target,
		tokens: ev.tokens,
		collapsed: ev.collapsed,
		upstream_status: ev.upstream_status,
		flight_id: ev.flight_id,
	};
}

export function fromS3(ev: S3Event): UnifiedEvent {
	return {
		id: ev.id + S3_EVENT_ID_OFFSET,
		source: 's3',
		status: ev.status,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		raw: ev,
		credential_id: ev.credential_id,
		operation: ev.operation,
		bucket: ev.bucket,
		s3_key: ev.key,
	};
}

export function fromDns(ev: DnsEvent): UnifiedEvent {
	return {
		id: ev.id + DNS_EVENT_ID_OFFSET,
		source: 'dns',
		status: ev.status,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		raw: ev,
		key_id: ev.key_id,
		zone_id: ev.zone_id,
		dns_action: ev.action,
		dns_name: ev.record_name,
		dns_type: ev.record_type,
		upstream_status: ev.upstream_status,
	};
}

/** CF proxy sources use the service name directly (d1, kv, workers, etc.). */
export const CF_PROXY_SOURCES = new Set(['d1', 'kv', 'workers', 'queues', 'vectorize', 'hyperdrive']);

export function isCfProxySource(source: string): boolean {
	return CF_PROXY_SOURCES.has(source);
}

export function fromCfProxy(ev: CfProxyEvent): UnifiedEvent {
	return {
		id: ev.id + CF_EVENT_ID_OFFSET,
		source: ev.service,
		status: ev.status,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		raw: ev,
		key_id: ev.key_id,
		upstream_status: ev.upstream_status,
		cf_service: ev.service,
		cf_action: ev.action,
		cf_account_id: ev.account_id,
		cf_resource_id: ev.resource_id,
	};
}

// ─── Flight grouping ────────────────────────────────────────────────

/**
 * Group events by flight_id. Events with the same flight_id are grouped together,
 * with the leader (collapsed=null) as the parent. S3 events and purge events
 * without a flight_id are treated as standalone groups.
 */
export function groupByFlight(events: UnifiedEvent[]): FlightGroup[] {
	const flightMap = new Map<string, UnifiedEvent[]>();
	const standalone: FlightGroup[] = [];

	for (const ev of events) {
		if (ev.source === 'purge' && ev.flight_id) {
			const group = flightMap.get(ev.flight_id);
			if (group) group.push(ev);
			else flightMap.set(ev.flight_id, [ev]);
		} else {
			standalone.push({ leader: ev, followers: [], sortKey: ev.created_at });
		}
	}

	const groups: FlightGroup[] = [...standalone];

	for (const [, members] of flightMap) {
		// Find the leader (collapsed=null) — if multiple non-collapsed, pick the earliest
		const leaderIdx = members.findIndex((e) => !e.collapsed);
		const leader = leaderIdx >= 0 ? members[leaderIdx] : members[0];
		const followers = members.filter((e) => e !== leader);
		// Sort followers by created_at ascending
		followers.sort((a, b) => a.created_at - b.created_at);
		groups.push({ leader, followers, sortKey: leader.created_at });
	}

	return groups;
}
