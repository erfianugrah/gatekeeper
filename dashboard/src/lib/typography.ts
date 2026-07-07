// ─── Shared Typography Constants ─────────────────────────────────────
// Single source of truth for recurring text patterns.
// Import as `T` and compose with `cn()` for contextual overrides.

export const T = {
	// ── Page-level ────────────────────────────────────────────────────
	pageTitle: 'text-lg font-semibold',
	pageDescription: 'text-sm text-muted-foreground',

	// ── Cards ─────────────────────────────────────────────────────────
	cardTitle: 'text-sm',

	// ── Section headings ──────────────────────────────────────────────
	sectionHeading: 'text-sm font-semibold',
	sectionLabel: 'text-xs font-medium uppercase tracking-wider text-muted-foreground',

	// ── Stat values & labels ──────────────────────────────────────────
	statValue: 'text-2xl font-bold tabular-nums font-data',
	statValueSm: 'text-xl font-bold tabular-nums font-data',
	statLabel: 'text-xs text-muted-foreground',
	statLabelUpper: 'text-xs font-medium uppercase tracking-wider text-muted-foreground',

	// ── Form labels ───────────────────────────────────────────────────
	formLabel: 'text-xs uppercase tracking-wider text-muted-foreground',

	// ── Table cells ───────────────────────────────────────────────────
	tableCell: 'text-xs',
	tableCellMono: 'text-xs font-data',
	tableCellNumeric: 'text-xs font-data tabular-nums text-right',
	tableRowName: 'text-xs font-medium',

	// ── Muted helpers ─────────────────────────────────────────────────
	muted: 'text-xs text-muted-foreground',
	mutedSm: 'text-sm text-muted-foreground',

	// ── Chart font sizes (px) ────────────────────────────────────────
	chartAxisTick: 10,
	chartAxisTitle: 11,
	chartLabel: 11,
	chartLabelSm: 10,
} as const;
