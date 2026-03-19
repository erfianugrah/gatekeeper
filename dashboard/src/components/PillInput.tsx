import { useState, useRef, useCallback } from 'react';
import type { KeyboardEvent, ClipboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PillInputProps {
	/** Current list of values. */
	values: string[];
	/** Called when the list changes. */
	onChange: (values: string[]) => void;
	/** Placeholder shown when no values and input is empty. */
	placeholder?: string;
	/** Optional validation function — return an error string or null. */
	validate?: (value: string) => string | null;
	/** Maximum number of pills allowed. Defaults to unlimited. */
	max?: number;
	/** Additional class names for the outer container. */
	className?: string;
	/** Accessible label for the input. */
	ariaLabel?: string;
}

/**
 * A text input that converts entries into removable pills.
 *
 * Values are committed on Enter, Tab, comma, or paste (multi-line).
 * Backspace on an empty input removes the last pill.
 */
export function PillInput({ values, onChange, placeholder, validate, max, className, ariaLabel }: PillInputProps) {
	const [input, setInput] = useState('');
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	/** Add one or more values, deduplicating and trimming. */
	const addValues = useCallback(
		(raw: string[]) => {
			setError(null);
			const existing = new Set(values);
			const toAdd: string[] = [];

			for (const r of raw) {
				const trimmed = r.trim();
				if (!trimmed) continue;
				if (existing.has(trimmed)) continue;
				if (max && values.length + toAdd.length >= max) break;
				if (validate) {
					const err = validate(trimmed);
					if (err) {
						setError(err);
						return;
					}
				}
				existing.add(trimmed);
				toAdd.push(trimmed);
			}

			if (toAdd.length > 0) {
				onChange([...values, ...toAdd]);
				setInput('');
			}
		},
		[values, onChange, validate, max],
	);

	const removeValue = useCallback(
		(index: number) => {
			setError(null);
			onChange(values.filter((_, i) => i !== index));
		},
		[values, onChange],
	);

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		const trimmed = input.trim();

		if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
			if (trimmed) {
				e.preventDefault();
				addValues([trimmed]);
			} else if (e.key === ',') {
				e.preventDefault();
			}
			return;
		}

		if (e.key === 'Backspace' && !input && values.length > 0) {
			removeValue(values.length - 1);
		}
	};

	const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
		const pasted = e.clipboardData.getData('text');
		// Split on newlines, commas, or spaces (for multi-value paste)
		const items = pasted
			.split(/[\n,]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (items.length > 1) {
			e.preventDefault();
			addValues(items);
		}
		// Single value: let the default paste behavior fill the input
	};

	const atMax = max !== undefined && values.length >= max;

	return (
		<div className={cn('space-y-1.5', className)}>
			<div
				className={cn(
					'flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 py-1.5 shadow-sm transition-colors',
					'focus-within:ring-1 focus-within:ring-ring',
					error && 'border-lv-red',
				)}
				onClick={() => inputRef.current?.focus()}
			>
				{values.map((value, i) => (
					<span
						key={`${value}-${i}`}
						className="inline-flex items-center gap-1 rounded-md bg-lv-purple/15 px-2 py-0.5 font-data text-xs text-lv-purple"
					>
						<span className="max-w-[260px] truncate">{value}</span>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								removeValue(i);
							}}
							className="rounded-sm p-0.5 transition-colors hover:bg-lv-purple/20"
							aria-label={`Remove ${value}`}
						>
							<X className="h-3 w-3" />
						</button>
					</span>
				))}
				{!atMax && (
					<input
						ref={inputRef}
						type="text"
						value={input}
						onChange={(e) => {
							setError(null);
							setInput(e.target.value);
						}}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						onBlur={() => {
							// Commit on blur if there's a value
							const trimmed = input.trim();
							if (trimmed) addValues([trimmed]);
						}}
						placeholder={values.length === 0 ? placeholder : ''}
						className="min-w-[120px] flex-1 bg-transparent font-data text-xs outline-none placeholder:text-muted-foreground"
						aria-label={ariaLabel}
					/>
				)}
			</div>
			{error && <p className="text-xs text-lv-red">{error}</p>}
		</div>
	);
}
