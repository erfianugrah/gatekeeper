import { TableRow, TableCell } from '@/components/ui/table';
import { formatTimeISO } from './analytics-helpers';
import type { UnifiedEvent } from './analytics-types';
import type { PurgeEvent, S3Event } from '@/lib/api';

// ─── Detail row (expanded) ──────────────────────────────────────────

type FieldType = 'id' | 'string' | 'number' | 'status' | 'duration' | 'timestamp' | 'null' | 'operation';

interface DetailField {
	key: string;
	value: string | number | null | undefined;
	type: FieldType;
}

function coloredValue(field: DetailField): React.ReactNode {
	const { value, type } = field;

	if (value === null || value === undefined) {
		return <span className="italic text-muted-foreground/40">null</span>;
	}

	switch (type) {
		case 'id':
			return <span className="text-lv-cyan">{String(value)}</span>;
		case 'status': {
			const n = Number(value);
			if (n >= 200 && n < 300) return <span className="text-lv-green font-semibold">{n}</span>;
			if (n === 429) return <span className="text-lv-peach font-semibold">{n}</span>;
			if (n >= 400) return <span className="text-lv-red font-semibold">{n}</span>;
			return <span className="font-semibold">{n}</span>;
		}
		case 'duration':
			return (
				<span className="text-lv-peach">
					{value} <span className="text-muted-foreground">ms</span>
				</span>
			);
		case 'number':
			return <span className="text-lv-purple">{String(value)}</span>;
		case 'timestamp':
			return <span className="text-lv-blue">{String(value)}</span>;
		case 'operation':
			return <span className="text-lv-green font-medium">{String(value)}</span>;
		default:
			return <span className="text-foreground">{String(value)}</span>;
	}
}

export function EventDetailRow({ event }: { event: UnifiedEvent }) {
	const raw = event.raw;
	const fields: DetailField[] =
		event.source === 'purge'
			? [
					{ key: 'id', value: (raw as PurgeEvent).id, type: 'number' },
					{ key: 'key_id', value: event.key_id, type: 'id' },
					{ key: 'zone_id', value: event.zone_id, type: 'id' },
					{ key: 'purge_type', value: event.purge_type, type: 'operation' },
					{ key: 'purge_target', value: event.purge_target, type: 'string' },
					{ key: 'tokens', value: event.tokens, type: 'number' },
					{ key: 'status', value: event.status, type: 'status' },
					{ key: 'upstream_status', value: event.upstream_status, type: 'status' },
					{ key: 'collapsed', value: event.collapsed, type: 'string' },
					{ key: 'flight_id', value: event.flight_id, type: 'id' },
					{ key: 'duration_ms', value: event.duration_ms, type: 'duration' },
					{ key: 'created_by', value: (raw as PurgeEvent).created_by, type: 'id' },
					{ key: 'response_detail', value: (raw as PurgeEvent).response_detail, type: 'string' },
					{ key: 'created_at', value: formatTimeISO(event.created_at), type: 'timestamp' },
				]
			: [
					{ key: 'id', value: (raw as S3Event).id, type: 'number' },
					{ key: 'credential_id', value: event.credential_id, type: 'id' },
					{ key: 'operation', value: event.operation, type: 'operation' },
					{ key: 'bucket', value: event.bucket, type: 'string' },
					{ key: 'key', value: event.s3_key, type: 'string' },
					{ key: 'status', value: event.status, type: 'status' },
					{ key: 'duration_ms', value: event.duration_ms, type: 'duration' },
					{ key: 'created_by', value: (raw as S3Event).created_by, type: 'id' },
					{ key: 'response_detail', value: (raw as S3Event).response_detail, type: 'string' },
					{ key: 'created_at', value: formatTimeISO(event.created_at), type: 'timestamp' },
				];

	return (
		<TableRow className="bg-muted/30 hover:bg-muted/40 border-b border-border/50">
			<TableCell colSpan={7} className="px-6 py-3">
				<div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 max-w-2xl">
					{fields.map((field) => (
						<div key={field.key} className="contents">
							<span className="text-[11px] font-data text-muted-foreground/70 select-none">{field.key}</span>
							<span className="text-[11px] font-data break-all select-all">{coloredValue(field)}</span>
						</div>
					))}
				</div>
			</TableCell>
		</TableRow>
	);
}
