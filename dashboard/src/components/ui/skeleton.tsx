import { cn } from '@/lib/utils';

// No pulse animation -- static flat block. The design-utilitarian ethos
// forbids skeleton loaders as a UX pattern (fake perceived speed), but
// swapping every call site for a proper empty-state/spinner is a UX
// change beyond this aesthetic pass. This keeps the placeholder visually
// flat (no animation tax) pending a follow-up to remove it entirely.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn('bg-muted', className)} {...props} />;
}

export { Skeleton };
