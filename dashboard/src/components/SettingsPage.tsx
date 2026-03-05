import { useState, useCallback, useEffect } from 'react';
import { Save, RotateCcw, Loader2, Pencil, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getConfig, setConfig, resetConfigKey } from '@/lib/api';
import type { GatewayConfig, ConfigOverride } from '@/lib/api';
import { T } from '@/lib/typography';

// ─── Config key metadata ────────────────────────────────────────────

interface ConfigKeyMeta {
	label: string;
	description: string;
	unit: string;
	section: string;
}

const CONFIG_META: Record<string, ConfigKeyMeta> = {
	bulk_rate: {
		label: 'Bulk Rate',
		description: 'Tokens refilled per second for bulk purge requests',
		unit: 'req/s',
		section: 'Bulk Purge',
	},
	bulk_bucket_size: {
		label: 'Bulk Bucket Size',
		description: 'Maximum burst capacity for bulk purge token bucket',
		unit: 'tokens',
		section: 'Bulk Purge',
	},
	bulk_max_ops: {
		label: 'Bulk Max Ops',
		description: 'Maximum operations per bulk purge request',
		unit: 'ops',
		section: 'Bulk Purge',
	},
	single_rate: {
		label: 'Single Rate',
		description: 'Tokens refilled per second for single-file purge requests',
		unit: 'URLs/s',
		section: 'Single Purge',
	},
	single_bucket_size: {
		label: 'Single Bucket Size',
		description: 'Maximum burst capacity for single-file purge token bucket',
		unit: 'tokens',
		section: 'Single Purge',
	},
	single_max_ops: {
		label: 'Single Max Ops',
		description: 'Maximum URLs per single-file purge request',
		unit: 'URLs',
		section: 'Single Purge',
	},
	key_cache_ttl_ms: {
		label: 'Key Cache TTL',
		description: 'Duration to cache API key lookups in the Durable Object',
		unit: 'ms',
		section: 'Caching',
	},
	retention_days: {
		label: 'Retention Days',
		description: 'Number of days to retain analytics events before cleanup',
		unit: 'days',
		section: 'Retention',
	},
};

const SECTION_ORDER = ['Bulk Purge', 'Single Purge', 'Caching', 'Retention'];

// ─── Helpers ────────────────────────────────────────────────────────

function formatDate(epoch: number): string {
	return new Date(epoch).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function formatValue(value: number, unit: string): string {
	if (unit === 'ms' && value >= 1000) {
		return `${(value / 1000).toFixed(1)}s`;
	}
	return value.toLocaleString();
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function ConfigSkeleton() {
	return (
		<div className="space-y-4">
			{Array.from({ length: 4 }).map((_, i) => (
				<Skeleton key={i} className="h-24 w-full" />
			))}
		</div>
	);
}

// ─── Settings Page ──────────────────────────────────────────────────

export function SettingsPage() {
	const [config, setConfigState] = useState<GatewayConfig | null>(null);
	const [overrides, setOverrides] = useState<ConfigOverride[]>([]);
	const [defaults, setDefaults] = useState<Record<string, number>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [editValue, setEditValue] = useState('');
	const [saving, setSaving] = useState(false);
	const [resettingKey, setResettingKey] = useState<string | null>(null);

	const fetchConfig = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await getConfig();
			setConfigState(data.config);
			setOverrides(data.overrides);
			setDefaults(data.defaults);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load config');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchConfig();
	}, [fetchConfig]);

	const overrideMap = new Map(overrides.map((o) => [o.key, o]));

	const handleEdit = (key: string) => {
		const currentValue = config ? (config as unknown as Record<string, number>)[key] : 0;
		setEditingKey(key);
		setEditValue(String(currentValue));
	};

	const handleCancelEdit = () => {
		setEditingKey(null);
		setEditValue('');
	};

	const handleSave = async () => {
		if (!editingKey || !editValue.trim()) return;
		const numVal = Number(editValue);
		if (isNaN(numVal) || numVal <= 0 || !isFinite(numVal)) {
			setError('Value must be a positive number');
			return;
		}

		setSaving(true);
		setError(null);
		try {
			await setConfig({ [editingKey]: numVal });
			setEditingKey(null);
			setEditValue('');
			await fetchConfig();
		} catch (e: any) {
			setError(e.message ?? 'Failed to save config');
		} finally {
			setSaving(false);
		}
	};

	const handleReset = async (key: string) => {
		const meta = CONFIG_META[key];
		if (!confirm(`Reset "${meta?.label ?? key}" to its default value?`)) return;

		setResettingKey(key);
		setError(null);
		try {
			await resetConfigKey(key);
			await fetchConfig();
		} catch (e: any) {
			setError(e.message ?? 'Failed to reset config key');
		} finally {
			setResettingKey(null);
		}
	};

	// Group config keys by section
	const sections = SECTION_ORDER.map((section) => ({
		section,
		keys: Object.entries(CONFIG_META)
			.filter(([, meta]) => meta.section === section)
			.map(([key]) => key),
	}));

	const overrideCount = overrides.length;
	const totalKeys = Object.keys(CONFIG_META).length;

	return (
		<div className="space-y-6">
			{/* ── Header row ──────────────────────────────────────── */}
			<div>
				<h2 className={T.pageTitle}>Settings</h2>
				<p className={T.pageDescription}>
					Gateway configuration registry. Overrides take effect immediately. Reset to revert to the hardcoded default.
				</p>
			</div>

			{/* ── Summary badges ──────────────────────────────────── */}
			{config && (
				<div className="flex items-center gap-3">
					<Badge variant="outline" className="text-xs font-data">
						{totalKeys} keys
					</Badge>
					{overrideCount > 0 ? (
						<Badge className="bg-lv-amber/20 text-lv-amber border-lv-amber/30 text-xs font-data">
							{overrideCount} override{overrideCount !== 1 ? 's' : ''}
						</Badge>
					) : (
						<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30 text-xs font-data">All defaults</Badge>
					)}
				</div>
			)}

			{/* ── Error ──────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Loading ────────────────────────────────────────── */}
			{loading && <ConfigSkeleton />}

			{/* ── Config sections ─────────────────────────────────── */}
			{!loading && config && (
				<TooltipProvider>
					<div className="space-y-6">
						{sections.map(({ section, keys }) => (
							<Card key={section}>
								<CardHeader>
									<CardTitle className={T.sectionHeading}>{section}</CardTitle>
								</CardHeader>
								<CardContent className="p-0">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className={T.sectionLabel}>Setting</TableHead>
												<TableHead className={T.sectionLabel}>Value</TableHead>
												<TableHead className={T.sectionLabel}>Default</TableHead>
												<TableHead className={T.sectionLabel}>Source</TableHead>
												<TableHead className={T.sectionLabel}>Last Updated</TableHead>
												<TableHead className="text-right">
													<span className={T.sectionLabel}>Actions</span>
												</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{keys.map((key) => {
												const meta = CONFIG_META[key];
												const currentValue = (config as unknown as Record<string, number>)[key];
												const defaultValue = defaults[key];
												const override = overrideMap.get(key);
												const isOverridden = !!override;
												const isEditing = editingKey === key;

												return (
													<TableRow key={key}>
														<TableCell>
															<Tooltip>
																<TooltipTrigger asChild>
																	<div>
																		<div className={T.tableRowName}>{meta.label}</div>
																		<div className={T.muted}>{key}</div>
																	</div>
																</TooltipTrigger>
																<TooltipContent side="right" className="max-w-xs">
																	<p className="text-xs">{meta.description}</p>
																</TooltipContent>
															</Tooltip>
														</TableCell>
														<TableCell>
															{isEditing ? (
																<div className="flex items-center gap-2">
																	<Input
																		type="number"
																		className="h-7 w-28 text-xs font-data"
																		value={editValue}
																		onChange={(e) => setEditValue(e.target.value)}
																		onKeyDown={(e) => {
																			if (e.key === 'Enter') handleSave();
																			if (e.key === 'Escape') handleCancelEdit();
																		}}
																		min={1}
																		autoFocus
																	/>
																	<span className={T.muted}>{meta.unit}</span>
																</div>
															) : (
																<code className="text-xs font-data tabular-nums">
																	{formatValue(currentValue, meta.unit)}
																	<span className={T.muted}> {meta.unit}</span>
																</code>
															)}
														</TableCell>
														<TableCell>
															<code className="text-xs font-data tabular-nums text-muted-foreground">
																{formatValue(defaultValue, meta.unit)}
															</code>
														</TableCell>
														<TableCell>
															{isOverridden ? (
																<Badge className="bg-lv-amber/20 text-lv-amber border-lv-amber/30">Override</Badge>
															) : (
																<Badge variant="outline" className="text-muted-foreground">
																	Default
																</Badge>
															)}
														</TableCell>
														<TableCell className={T.tableCell}>
															{override ? (
																<div>
																	<div>{formatDate(override.updated_at)}</div>
																	{override.updated_by && <div className={T.muted}>{override.updated_by}</div>}
																</div>
															) : (
																<span className={T.muted}>--</span>
															)}
														</TableCell>
														<TableCell className="text-right">
															<div className="flex items-center justify-end gap-1">
																{isEditing ? (
																	<>
																		<Button
																			size="xs"
																			variant="ghost"
																			className="text-lv-green hover:text-lv-green hover:bg-lv-green/10"
																			onClick={handleSave}
																			disabled={saving}
																		>
																			{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
																			Save
																		</Button>
																		<Button size="xs" variant="ghost" onClick={handleCancelEdit}>
																			<X className="h-3.5 w-3.5" />
																		</Button>
																	</>
																) : (
																	<>
																		<Button
																			size="xs"
																			variant="ghost"
																			className="text-muted-foreground hover:text-foreground"
																			onClick={() => handleEdit(key)}
																		>
																			<Pencil className="h-3.5 w-3.5" />
																			Edit
																		</Button>
																		{isOverridden && (
																			<Button
																				size="xs"
																				variant="ghost"
																				className="text-lv-amber hover:text-lv-amber hover:bg-lv-amber/10"
																				onClick={() => handleReset(key)}
																				disabled={resettingKey === key}
																			>
																				{resettingKey === key ? (
																					<Loader2 className="h-3.5 w-3.5 animate-spin" />
																				) : (
																					<RotateCcw className="h-3.5 w-3.5" />
																				)}
																				Reset
																			</Button>
																		)}
																	</>
																)}
															</div>
														</TableCell>
													</TableRow>
												);
											})}
										</TableBody>
									</Table>
								</CardContent>
							</Card>
						))}
					</div>
				</TooltipProvider>
			)}
		</div>
	);
}
