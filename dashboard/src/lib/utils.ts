import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Safely copy text to the clipboard, logging on failure. */
export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch (e: any) {
		console.error('Clipboard write failed:', e);
		return false;
	}
}

// ─── Centralized Color Map ───────────────────────────────────────────
// McMaster status palette - used across charts, badges, and stat cards.

export const STATUS_COLORS = {
	success: '#6fab58', // status-ok - 200 OK
	error: '#ff5460', // status-danger - 4xx/5xx errors
	rate_limited: '#d9b96a', // status-warn - 429
	collapsed: '#7fa8c9', // status-info - collapsed requests
	denied: '#ff5460', // status-danger - 403 forbidden
} as const;

export const PURGE_TYPE_COLORS = {
	url: '#b08fc4', // status-accent - single-file purge by URL
	host: '#6bbfae', // status-info-alt - purge by host
	tag: '#6fab58', // status-ok - purge by cache tag
	prefix: '#d9b96a', // status-warn - purge by prefix
	everything: '#ff5460', // status-danger - purge everything
} as const;

// S3 operation category colors
export const S3_OP_COLORS = {
	read: '#6fab58', // status-ok - GetObject, HeadObject, etc.
	write: '#b08fc4', // status-accent - PutObject, DeleteObject, etc.
	list: '#6bbfae', // status-info-alt - ListBuckets, ListObjectsV2, etc.
	other: '#7fa8c9', // status-info - everything else
} as const;

// Palette for pie/bar chart series (cycles for arbitrary-length data)
export const CHART_PALETTE = ['#6fab58', '#d9b96a', '#ff5460', '#8c8474', '#7fa8c9', '#6bbfae', '#b08fc4'] as const;

// Shared chart tooltip styling (McMaster ink/paper theme)
export const CHART_TOOLTIP_STYLE = {
	contentStyle: {
		backgroundColor: '#1f1b14',
		border: '1px solid #3a342a',
		borderRadius: '0',
		fontSize: '12px',
		color: '#e8e0ce',
	},
	itemStyle: { color: '#e8e0ce' },
	labelStyle: { color: '#8c8474' },
};
