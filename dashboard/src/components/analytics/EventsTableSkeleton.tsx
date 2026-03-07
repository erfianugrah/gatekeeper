import { Skeleton } from '@/components/ui/skeleton';

// ─── Loading Skeleton ───────────────────────────────────────────────

export function EventsTableSkeleton() {
	return (
		<div className="space-y-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<Skeleton key={i} className="h-9 w-full" />
			))}
		</div>
	);
}
