import type { UnifiedEvent } from './analytics-types';

// ─── Formatting helpers ─────────────────────────────────────────────

export function formatTime(epoch: number): string {
	const d = new Date(epoch);
	return d.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
}

export function formatTimeISO(epoch: number): string {
	return new Date(epoch).toISOString();
}

export function truncateId(id: string, len = 10): string {
	return id.length > len ? `${id.slice(0, len)}...` : id;
}

// ─── Export helpers ──────────────────────────────────────────────────

export function exportToJson(events: UnifiedEvent[], filename: string): void {
	const raw = events.map((ev) => ev.raw);
	const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export async function copyToClipboard(events: UnifiedEvent[]): Promise<void> {
	const raw = events.map((ev) => ev.raw);
	try {
		await navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
	} catch (e: any) {
		console.error('Clipboard write failed:', e);
	}
}

// ─── Event text for search matching ─────────────────────────────────

export function eventSearchText(ev: UnifiedEvent): string {
	const parts = [
		ev.source,
		String(ev.status),
		ev.key_id ?? '',
		ev.zone_id ?? '',
		ev.credential_id ?? '',
		ev.operation ?? '',
		ev.bucket ?? '',
		ev.s3_key ?? '',
		ev.purge_type ?? '',
		ev.purge_target ?? '',
		ev.collapsed ?? '',
		ev.dns_action ?? '',
		ev.dns_name ?? '',
		ev.dns_type ?? '',
		(ev.raw as any).created_by ?? '',
		(ev.raw as any).response_detail ?? '',
	];
	return parts.join(' ').toLowerCase();
}
