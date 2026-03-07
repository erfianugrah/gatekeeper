import type { PurgeEvent, S3Event } from '@/lib/api';

// ─── Unified event type ─────────────────────────────────────────────

export type UnifiedEvent = {
	id: number;
	source: 'purge' | 's3';
	status: number;
	duration_ms: number;
	created_at: number;
	raw: PurgeEvent | S3Event;
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
export type TabFilter = 'all' | 'purge' | 's3';
export type StatusFilter = 'all' | '2xx' | '4xx' | '5xx';

// ─── Constants ──────────────────────────────────────────────────────

/** Offset to avoid ID collisions between purge events and S3 events in the unified view. */
export const S3_EVENT_ID_OFFSET = 1_000_000_000;

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
