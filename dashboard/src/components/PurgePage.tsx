import { useState, useEffect, useCallback } from 'react';
import { Send, Loader2, CheckCircle, XCircle, Save, Trash2, ChevronDown, ShieldAlert, Ban, Plus, X, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { PillInput } from '@/components/PillInput';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';

const ZONE_ID_RE = /^[a-f0-9]{32}$/;
const PROFILES_STORAGE_KEY = 'gk_purge_profiles';
const LAST_PROFILE_KEY = 'gk_purge_last_profile';

// ─── Types ──────────────────────────────────────────────────────────

type PurgeType = 'urls' | 'hosts' | 'tags' | 'prefixes' | 'everything';

interface PurgeOption {
	value: PurgeType;
	label: string;
	placeholder: string;
}

const PURGE_OPTIONS: PurgeOption[] = [
	{ value: 'urls', label: 'URLs', placeholder: 'https://example.com/style.css' },
	{ value: 'hosts', label: 'Hosts', placeholder: 'www.example.com' },
	{ value: 'tags', label: 'Tags', placeholder: 'tag-a' },
	{ value: 'prefixes', label: 'Prefixes', placeholder: 'www.example.com/css' },
	{ value: 'everything', label: 'Everything', placeholder: '' },
];

/** A URL entry that optionally includes custom cache key headers (CF API files format). */
interface UrlEntry {
	url: string;
	headers?: Record<string, string>;
}

/** Saved profile — no secrets, just convenience fields. */
interface PurgeProfile {
	id: string;
	name: string;
	zoneId: string;
	purgeType: PurgeType;
	/** Saved purge values (hosts, tags, prefixes, or URLs). Omitted in legacy profiles. */
	values?: string[];
	/** Saved URL entries with optional headers. Used when purgeType is 'urls'. */
	urlEntries?: UrlEntry[];
}

interface PurgeResponse {
	success: boolean;
	status: number;
	errors: Array<{ code: number; message: string }>;
	denied: string[];
	data: any;
}

// ─── Validators ─────────────────────────────────────────────────────

function validateZoneId(value: string): string | null {
	if (!ZONE_ID_RE.test(value)) return 'Zone ID must be a 32-character hex string';
	return null;
}

// ─── Profile Persistence ────────────────────────────────────────────

function loadProfiles(): PurgeProfile[] {
	try {
		const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

function saveProfiles(profiles: PurgeProfile[]) {
	localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}

function loadLastProfileId(): string | null {
	try {
		return localStorage.getItem(LAST_PROFILE_KEY);
	} catch {
		return null;
	}
}

function saveLastProfileId(id: string | null) {
	if (id) {
		localStorage.setItem(LAST_PROFILE_KEY, id);
	} else {
		localStorage.removeItem(LAST_PROFILE_KEY);
	}
}

// ─── URL Entry Editor ───────────────────────────────────────────

/** Common CF cache key headers for the header name suggestions. */
const CF_CACHE_HEADERS = ['CF-Device-Type', 'CF-IPCountry', 'Accept-Language', 'Accept-Encoding', 'Cookie', 'Origin', 'Referer'];

function UrlEntryEditor({ entries, onChange }: { entries: UrlEntry[]; onChange: (entries: UrlEntry[]) => void }) {
	const [inputValue, setInputValue] = useState('');
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	const addUrl = () => {
		const url = inputValue.trim();
		if (!url) return;
		// Deduplicate by URL
		if (entries.some((e) => e.url === url)) {
			setInputValue('');
			return;
		}
		onChange([...entries, { url }]);
		setInputValue('');
	};

	const removeEntry = (index: number) => {
		onChange(entries.filter((_, i) => i !== index));
		if (expandedIndex === index) setExpandedIndex(null);
		else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
	};

	const addHeader = (index: number) => {
		const updated = [...entries];
		const existing = updated[index].headers ?? {};
		updated[index] = { ...updated[index], headers: { ...existing, '': '' } };
		onChange(updated);
	};

	const updateHeaderKey = (entryIndex: number, oldKey: string, newKey: string) => {
		const updated = [...entries];
		const headers = { ...updated[entryIndex].headers };
		const value = headers[oldKey] ?? '';
		delete headers[oldKey];
		headers[newKey] = value;
		updated[entryIndex] = { ...updated[entryIndex], headers };
		onChange(updated);
	};

	const updateHeaderValue = (entryIndex: number, key: string, value: string) => {
		const updated = [...entries];
		updated[entryIndex] = { ...updated[entryIndex], headers: { ...updated[entryIndex].headers, [key]: value } };
		onChange(updated);
	};

	const removeHeader = (entryIndex: number, key: string) => {
		const updated = [...entries];
		const headers = { ...updated[entryIndex].headers };
		delete headers[key];
		updated[entryIndex] = { ...updated[entryIndex], headers: Object.keys(headers).length > 0 ? headers : undefined };
		onChange(updated);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			addUrl();
		}
	};

	const handlePaste = (e: React.ClipboardEvent) => {
		const text = e.clipboardData.getData('text');
		const lines = text
			.split(/[\n,]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (lines.length > 1) {
			e.preventDefault();
			const existing = new Set(entries.map((en) => en.url));
			const newEntries = lines.filter((l) => !existing.has(l)).map((url) => ({ url }));
			onChange([...entries, ...newEntries]);
			setInputValue('');
		}
	};

	return (
		<div className="space-y-2">
			{/* URL list */}
			{entries.length > 0 && (
				<div className="space-y-1">
					{entries.map((entry, i) => {
						const headerCount = entry.headers ? Object.keys(entry.headers).length : 0;
						const isExpanded = expandedIndex === i;
						return (
							<div key={i} className="rounded-md border border-border bg-lovelace-950/50">
								<div className="flex items-center gap-1.5 px-2 py-1.5">
									<button
										type="button"
										onClick={() => setExpandedIndex(isExpanded ? null : i)}
										className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
										title={isExpanded ? 'Collapse headers' : 'Expand headers'}
									>
										<ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
									</button>
									<span className="min-w-0 flex-1 truncate font-data text-xs text-foreground">{entry.url}</span>
									{headerCount > 0 && (
										<span className="shrink-0 rounded bg-lv-purple/20 px-1.5 py-0.5 text-[10px] font-medium text-lv-purple">
											{headerCount} header{headerCount !== 1 ? 's' : ''}
										</span>
									)}
									<button
										type="button"
										onClick={() => removeEntry(i)}
										className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-lv-red"
										aria-label={`Remove ${entry.url}`}
									>
										<X className="h-3 w-3" />
									</button>
								</div>
								{isExpanded && (
									<div className="border-t border-border/50 px-3 py-2 space-y-1.5">
										<p className="text-[10px] text-muted-foreground">
											Custom cache key headers (e.g. CF-Device-Type for device-specific cache variants)
										</p>
										{entry.headers &&
											Object.entries(entry.headers).map(([key, value]) => (
												<div key={key || '__new'} className="flex items-center gap-1.5">
													<Input
														placeholder="Header name"
														defaultValue={key}
														onBlur={(e) => updateHeaderKey(i, key, e.target.value.trim())}
														className="h-7 flex-1 font-data text-xs"
														list="cf-header-suggestions"
													/>
													<Input
														placeholder="Value"
														value={value}
														onChange={(e) => updateHeaderValue(i, key, e.target.value)}
														className="h-7 flex-1 font-data text-xs"
													/>
													<button
														type="button"
														onClick={() => removeHeader(i, key)}
														className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-lv-red"
													>
														<X className="h-3 w-3" />
													</button>
												</div>
											))}
										<Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => addHeader(i)}>
											<Plus className="mr-1 h-3 w-3" />
											Add header
										</Button>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{/* Add URL input */}
			<div className="flex gap-1.5">
				<Input
					placeholder="https://example.com/style.css"
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					className="font-data text-xs"
					aria-label="Purge values"
				/>
				<Button type="button" variant="outline" size="sm" onClick={addUrl} disabled={!inputValue.trim()} className="shrink-0">
					<Plus className="h-3.5 w-3.5" />
				</Button>
			</div>
			<p className={T.muted}>Enter URLs to purge. Expand each entry to add custom cache key headers. Paste multiple URLs at once.</p>

			{/* Datalist for header name suggestions */}
			<datalist id="cf-header-suggestions">
				{CF_CACHE_HEADERS.map((h) => (
					<option key={h} value={h} />
				))}
			</datalist>
		</div>
	);
}

// ─── Purge Page ─────────────────────────────────────────────────────

export function PurgePage() {
	// ── Profile state ────────────────────────────────────────────────
	const [profiles, setProfiles] = useState<PurgeProfile[]>([]);
	const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
	const [saveDialogOpen, setSaveDialogOpen] = useState(false);
	const [saveProfileName, setSaveProfileName] = useState('');
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);

	// ── Form state ───────────────────────────────────────────────────
	const [zoneIds, setZoneIds] = useState<string[]>([]);
	const [purgeType, setPurgeType] = useState<PurgeType>('urls');
	const [purgeValues, setPurgeValues] = useState<string[]>([]);
	const [urlEntries, setUrlEntries] = useState<UrlEntry[]>([]);
	const [apiKey, setApiKey] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [response, setResponse] = useState<PurgeResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	const selectedOption = PURGE_OPTIONS.find((o) => o.value === purgeType)!;
	const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;

	// ── Load profiles on mount ───────────────────────────────────────
	useEffect(() => {
		const loaded = loadProfiles();
		setProfiles(loaded);
		const lastId = loadLastProfileId();
		if (lastId) {
			const profile = loaded.find((p) => p.id === lastId);
			if (profile) {
				setActiveProfileId(lastId);
				setZoneIds([profile.zoneId]);
				setPurgeType(profile.purgeType);
				if (profile.purgeType === 'urls' && profile.urlEntries) {
					setUrlEntries(profile.urlEntries);
				} else if (profile.values) {
					setPurgeValues(profile.values);
				}
			}
		}
	}, []);

	// ── Close dropdown on outside click ──────────────────────────────
	useEffect(() => {
		if (!profileDropdownOpen) return;
		const handleClick = () => setProfileDropdownOpen(false);
		document.addEventListener('click', handleClick);
		return () => document.removeEventListener('click', handleClick);
	}, [profileDropdownOpen]);

	// ── Profile actions ──────────────────────────────────────────────
	const applyProfile = useCallback((profile: PurgeProfile) => {
		setActiveProfileId(profile.id);
		setZoneIds([profile.zoneId]);
		setPurgeType(profile.purgeType);
		if (profile.purgeType === 'urls' && profile.urlEntries) {
			setUrlEntries(profile.urlEntries);
			setPurgeValues([]);
		} else {
			setPurgeValues(profile.values ?? []);
			setUrlEntries([]);
		}
		setResponse(null);
		setError(null);
		saveLastProfileId(profile.id);
	}, []);

	const clearProfile = useCallback(() => {
		setActiveProfileId(null);
		setZoneIds([]);
		setApiKey('');
		setPurgeType('urls');
		setPurgeValues([]);
		setUrlEntries([]);
		setResponse(null);
		setError(null);
		saveLastProfileId(null);
	}, []);

	const handleSaveProfile = () => {
		const name = saveProfileName.trim();
		if (!name || zoneIds.length === 0) return;

		const newProfile: PurgeProfile = {
			id: crypto.randomUUID(),
			name,
			zoneId: zoneIds[0],
			purgeType,
			...(purgeType === 'urls'
				? { urlEntries: urlEntries.length > 0 ? urlEntries : undefined }
				: { values: purgeValues.length > 0 ? purgeValues : undefined }),
		};

		const updated = [...profiles, newProfile];
		setProfiles(updated);
		saveProfiles(updated);
		setActiveProfileId(newProfile.id);
		saveLastProfileId(newProfile.id);
		setSaveDialogOpen(false);
		setSaveProfileName('');
	};

	const handleUpdateProfile = () => {
		if (!activeProfileId || zoneIds.length === 0) return;
		const updated = profiles.map((p) =>
			p.id === activeProfileId
				? {
						...p,
						zoneId: zoneIds[0],
						purgeType,
						...(purgeType === 'urls'
							? { urlEntries: urlEntries.length > 0 ? urlEntries : undefined, values: undefined }
							: { values: purgeValues.length > 0 ? purgeValues : undefined, urlEntries: undefined }),
					}
				: p,
		);
		setProfiles(updated);
		saveProfiles(updated);
	};

	const handleDeleteProfile = (id: string) => {
		const updated = profiles.filter((p) => p.id !== id);
		setProfiles(updated);
		saveProfiles(updated);
		if (activeProfileId === id) {
			clearProfile();
		}
		setDeleteConfirmId(null);
	};

	// ── Purge logic ──────────────────────────────────────────────────

	const buildBody = (): Record<string, any> => {
		if (purgeType === 'everything') {
			return { purge_everything: true };
		}

		if (purgeType === 'urls') {
			if (urlEntries.length === 0) throw new Error('Enter at least one URL');
			// Emit { url, headers } objects when headers are present, plain strings otherwise
			const files = urlEntries.map((entry) =>
				entry.headers && Object.keys(entry.headers).length > 0 ? { url: entry.url, headers: entry.headers } : entry.url,
			);
			return { files };
		}

		if (purgeValues.length === 0) {
			throw new Error('Enter at least one value');
		}

		const fieldMap: Record<string, string> = {
			hosts: 'hosts',
			tags: 'tags',
			prefixes: 'prefixes',
		};

		return { [fieldMap[purgeType]]: purgeValues };
	};

	const handleSubmit = async () => {
		setError(null);
		setResponse(null);

		if (zoneIds.length === 0) {
			setError('Zone ID is required');
			return;
		}
		if (!apiKey.trim()) {
			setError('API key is required');
			return;
		}

		let body: Record<string, any>;
		try {
			body = buildBody();
		} catch (e: any) {
			setError(e.message);
			return;
		}

		setSubmitting(true);
		try {
			const res = await fetch(`/v1/zones/${zoneIds[0]}/purge_cache`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey.trim()}`,
				},
				body: JSON.stringify(body),
			});

			let data: any;
			try {
				data = await res.json();
			} catch {
				setError(`Server returned non-JSON response (HTTP ${res.status})`);
				return;
			}
			setResponse({
				success: data.success ?? res.ok,
				status: res.status,
				errors: data.errors ?? [],
				denied: data.denied ?? [],
				data,
			});
		} catch (e: any) {
			setError(e.message ?? 'Request failed');
		} finally {
			setSubmitting(false);
		}
	};

	// ── Check if form has diverged from active profile ───────────────
	const valuesChanged =
		purgeType === 'urls'
			? JSON.stringify(urlEntries) !== JSON.stringify(activeProfile?.urlEntries ?? [])
			: JSON.stringify(purgeValues) !== JSON.stringify(activeProfile?.values ?? []);
	const formDirty =
		activeProfile !== null && ((zoneIds[0] ?? '') !== activeProfile.zoneId || purgeType !== activeProfile.purgeType || valuesChanged);

	return (
		<div className="mx-auto max-w-2xl space-y-6">
			{/* ── Profile Selector ──────────────────────────────────── */}
			<Card>
				<CardContent className="py-4">
					<div className="flex items-center gap-3">
						<Label className={cn(T.formLabel, 'shrink-0')}>Profile</Label>
						<div className="relative flex-1">
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									setProfileDropdownOpen(!profileDropdownOpen);
								}}
								className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								<span className={activeProfile ? 'text-foreground' : 'text-muted-foreground'}>
									{activeProfile ? activeProfile.name : 'Select a profile...'}
								</span>
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							</button>

							{profileDropdownOpen && (
								<div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
									{profiles.length === 0 ? (
										<div className="px-3 py-4 text-center text-xs text-muted-foreground">
											No saved profiles. Fill in the form below and save one.
										</div>
									) : (
										<div className="max-h-60 overflow-y-auto py-1">
											{profiles.map((profile) => (
												<div key={profile.id} className="group flex items-center justify-between px-3 py-2 hover:bg-muted/50">
													<button
														type="button"
														onClick={() => {
															applyProfile(profile);
															setProfileDropdownOpen(false);
														}}
														className="flex flex-1 flex-col items-start gap-0.5 text-left"
													>
														<span className={cn('text-sm', profile.id === activeProfileId && 'font-medium text-lv-purple')}>
															{profile.name}
														</span>
														<span className="font-data text-[10px] text-muted-foreground">
															{profile.zoneId.slice(0, 8)}...{profile.zoneId.slice(-4)}
														</span>
													</button>
													<button
														type="button"
														onClick={(e) => {
															e.stopPropagation();
															setDeleteConfirmId(profile.id);
															setProfileDropdownOpen(false);
														}}
														className="rounded p-1 opacity-0 transition-opacity hover:bg-lv-red/20 group-hover:opacity-100"
														title="Delete profile"
													>
														<Trash2 className="h-3.5 w-3.5 text-lv-red" />
													</button>
												</div>
											))}
										</div>
									)}
									{activeProfile && (
										<>
											<Separator />
											<button
												type="button"
												onClick={() => {
													clearProfile();
													setProfileDropdownOpen(false);
												}}
												className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
											>
												Clear selection
											</button>
										</>
									)}
								</div>
							)}
						</div>

						{/* Save / Update buttons */}
						<div className="flex shrink-0 gap-2">
							{activeProfile && formDirty && (
								<Button variant="outline" size="sm" onClick={handleUpdateProfile} title="Update this profile">
									<Save className="mr-1 h-3.5 w-3.5" />
									Update
								</Button>
							)}
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									setSaveProfileName('');
									setSaveDialogOpen(true);
								}}
								disabled={zoneIds.length === 0}
								title="Save as new profile"
							>
								<Save className="mr-1 h-3.5 w-3.5" />
								Save As
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* ── Manual Purge Form ────────────────────────────────── */}
			<Card>
				<CardHeader>
					<CardTitle className={T.sectionHeading}>Manual Purge</CardTitle>
					<p className={T.muted}>Send a purge request directly to the gateway API using your API key.</p>
				</CardHeader>
				<CardContent className="space-y-5">
					{/* ── Zone ID ────────────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Zone ID</Label>
						<PillInput
							values={zoneIds}
							onChange={setZoneIds}
							placeholder="e.g. abc123def456..."
							validate={validateZoneId}
							max={1}
							ariaLabel="Zone ID"
						/>
					</div>

					{/* ── API Key ────────────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>API Key</Label>
						<Input
							type="password"
							placeholder="Bearer token..."
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							className="font-data"
						/>
						<p className={T.muted}>Used as the Authorization: Bearer header.</p>
					</div>

					<Separator />

					{/* ── Purge Type ─────────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Purge Type</Label>
						<select
							value={purgeType}
							onChange={(e) => {
								setPurgeType(e.target.value as PurgeType);
								setPurgeValues([]);
								setUrlEntries([]);
							}}
							className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{PURGE_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value} className="bg-lovelace-800">
									{opt.label}
								</option>
							))}
						</select>
					</div>

					{/* ── Values ──────────────────────────────────────────── */}
					{purgeType === 'urls' && (
						<div className="space-y-2">
							<Label className={T.formLabel}>URLs</Label>
							<UrlEntryEditor entries={urlEntries} onChange={setUrlEntries} />
						</div>
					)}
					{purgeType !== 'everything' && purgeType !== 'urls' && (
						<div className="space-y-2">
							<Label className={T.formLabel}>Values</Label>
							<PillInput values={purgeValues} onChange={setPurgeValues} placeholder={selectedOption.placeholder} ariaLabel="Purge values" />
							<p className={T.muted}>Press Enter or comma to add. Paste multiple values at once.</p>
						</div>
					)}

					{purgeType === 'everything' && (
						<div className="rounded-lg border border-lv-peach/30 bg-lv-peach/10 px-4 py-3">
							<p className="text-sm text-lv-peach">This will purge all cached content for the zone. Use with caution.</p>
						</div>
					)}

					{/* ── Submit ──────────────────────────────────────────── */}
					<Button
						onClick={handleSubmit}
						disabled={
							submitting ||
							zoneIds.length === 0 ||
							!apiKey.trim() ||
							(purgeType === 'urls' && urlEntries.length === 0) ||
							(purgeType !== 'urls' && purgeType !== 'everything' && purgeValues.length === 0)
						}
						className="w-full"
					>
						{submitting ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Sending...
							</>
						) : (
							<>
								<Send className="h-4 w-4" />
								Send Purge Request
							</>
						)}
					</Button>
				</CardContent>
			</Card>

			{/* ── Error ──────────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Response ───────────────────────────────────────────── */}
			{response && (
				<Card>
					<CardHeader>
						<CardTitle className={cn(T.sectionHeading, 'flex items-center gap-2')}>
							{response.success ? (
								<>
									<CheckCircle className="h-4 w-4 text-lv-green" />
									<span className="text-lv-green">Success</span>
								</>
							) : (
								<>
									{response.status === 403 ? (
										<ShieldAlert className="h-4 w-4 text-lv-peach" />
									) : (
										<XCircle className="h-4 w-4 text-lv-red" />
									)}
									<span className={response.status === 403 ? 'text-lv-peach' : 'text-lv-red'}>
										{response.status === 401
											? 'Unauthorized'
											: response.status === 403
												? 'Forbidden'
												: response.status === 429
													? 'Rate Limited'
													: `Error ${response.status}`}
									</span>
								</>
							)}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{/* Error messages */}
						{!response.success && response.errors.length > 0 && (
							<div className="space-y-1.5">
								{response.errors.map((err, i) => (
									<div key={i} className="flex items-start gap-2 text-sm">
										<Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-lv-red" />
										<span className="text-foreground">{err.message}</span>
									</div>
								))}
							</div>
						)}

						{/* Denied items (policy violations) */}
						{response.denied.length > 0 && (
							<div className="space-y-1.5">
								<p className={cn(T.formLabel, 'text-lv-peach')}>Denied targets</p>
								<div className="flex flex-wrap gap-1.5">
									{response.denied.map((item, i) => (
										<span key={i} className="inline-flex items-center rounded-md bg-lv-red/10 px-2 py-0.5 font-data text-xs text-lv-red">
											{item}
										</span>
									))}
								</div>
							</div>
						)}

						{/* Raw response (collapsible for debugging) */}
						<details className="group">
							<summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Raw response</summary>
							<pre className="mt-2 overflow-auto rounded-lg bg-lovelace-950 p-4 font-data text-xs leading-relaxed text-foreground">
								{JSON.stringify(response.data, null, 2)}
							</pre>
						</details>
					</CardContent>
				</Card>
			)}

			{/* ── Save Profile Dialog ──────────────────────────────── */}
			<Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Save Profile</DialogTitle>
						<DialogDescription>
							Save the current zone ID, purge type, and values as a reusable profile. Profiles are stored locally in your browser.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label className={T.formLabel}>Profile Name</Label>
						<Input
							placeholder="e.g. Production CDN, Staging site..."
							value={saveProfileName}
							onChange={(e) => setSaveProfileName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') handleSaveProfile();
							}}
							autoFocus
						/>
						{zoneIds[0] && (
							<p className={T.muted}>
								Zone: {zoneIds[0].slice(0, 8)}...{zoneIds[0].slice(-4)}
							</p>
						)}
					</div>
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						<Button onClick={handleSaveProfile} disabled={!saveProfileName.trim()}>
							<Save className="mr-1 h-3.5 w-3.5" />
							Save Profile
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* ── Delete Confirmation Dialog ───────────────────────── */}
			<Dialog open={deleteConfirmId !== null} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete Profile</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete &ldquo;{profiles.find((p) => p.id === deleteConfirmId)?.name}&rdquo;? This cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						<Button variant="destructive" onClick={() => deleteConfirmId && handleDeleteProfile(deleteConfirmId)}>
							<Trash2 className="mr-1 h-3.5 w-3.5" />
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
