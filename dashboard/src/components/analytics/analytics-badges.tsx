import { Cloud, HardDrive } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// ─── Tooltip descriptions ───────────────────────────────────────────

export const PURGE_TYPE_TOOLTIPS: Record<string, string> = {
	url: 'Purge by exact URL (single-file rate class)',
	host: 'Purge all cached content for a hostname',
	tag: 'Purge by Cache-Tag header value',
	prefix: 'Purge by URL prefix (path-based)',
	everything: 'Purge all cached content for the zone',
};

export const COLLAPSED_TOOLTIPS: Record<string, string> = {
	isolate: 'Deduplicated — an identical request was already in-flight within the same V8 isolate',
	do: 'Deduplicated — an identical request was already in-flight within the Durable Object',
};

const SOURCE_TOOLTIPS: Record<string, string> = {
	purge: 'Cloudflare cache purge request',
	s3: 'S3/R2 object storage request',
};

// ─── Tooltip wrapper ────────────────────────────────────────────────

/** Wrap a node in a tooltip. */
export function WithTooltip({ tip, children }: { tip: string; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent>
				<p className="text-xs font-data max-w-[300px]">{tip}</p>
			</TooltipContent>
		</Tooltip>
	);
}

// ─── Badge helpers ──────────────────────────────────────────────────

export function purgeTypeBadgeClass(type?: string): string {
	switch (type) {
		case 'url':
			return 'bg-lv-purple/20 text-lv-purple border-lv-purple/30';
		case 'host':
			return 'bg-lv-cyan/20 text-lv-cyan border-lv-cyan/30';
		case 'tag':
			return 'bg-lv-green/20 text-lv-green border-lv-green/30';
		case 'prefix':
			return 'bg-lv-peach/20 text-lv-peach border-lv-peach/30';
		case 'everything':
			return 'bg-lv-red-bright/20 text-lv-red-bright border-lv-red-bright/30';
		default:
			return 'bg-muted/20 text-muted-foreground border-muted/30';
	}
}

export function statusTooltip(status: number): string {
	if (status >= 200 && status < 300) return `${status} — Success`;
	if (status === 401) return '401 — Unauthorized (invalid or missing API key)';
	if (status === 403) return '403 — Forbidden (policy denied the request)';
	if (status === 429) return '429 — Rate limited (token bucket exhausted)';
	if (status >= 400 && status < 500) return `${status} — Client error`;
	if (status >= 500) return `${status} — Server error`;
	return String(status);
}

export function statusBadge(status: number): React.ReactNode {
	const tip = statusTooltip(status);
	let badge: React.ReactNode;
	if (status >= 200 && status < 300) {
		badge = <Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">{status}</Badge>;
	} else if (status === 429) {
		badge = <Badge className="bg-lv-peach/20 text-lv-peach border-lv-peach/30">{status}</Badge>;
	} else if (status === 403) {
		badge = <Badge className="bg-lv-red-bright/20 text-lv-red-bright border-lv-red-bright/30">{status}</Badge>;
	} else if (status >= 400) {
		badge = <Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">{status}</Badge>;
	} else {
		badge = <Badge variant="secondary">{status}</Badge>;
	}
	return <WithTooltip tip={tip}>{badge}</WithTooltip>;
}

export function sourceBadge(source: 'purge' | 's3'): React.ReactNode {
	const tip = SOURCE_TOOLTIPS[source] ?? source;
	if (source === 'purge') {
		return (
			<WithTooltip tip={tip}>
				<Badge className="bg-lv-purple/20 text-lv-purple border-lv-purple/30 gap-1">
					<Cloud className="h-3 w-3" />
					Purge
				</Badge>
			</WithTooltip>
		);
	}
	return (
		<WithTooltip tip={tip}>
			<Badge className="bg-lv-cyan/20 text-lv-cyan border-lv-cyan/30 gap-1">
				<HardDrive className="h-3 w-3" />
				S3
			</Badge>
		</WithTooltip>
	);
}
