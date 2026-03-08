// ─── JSON Syntax Highlighter ────────────────────────────────────────
// Renders pretty-printed JSON with Lovelace theme colors.
// Keys → lv-cyan, strings → lv-green, numbers → lv-purple,
// booleans → lv-peach, null → muted-foreground, punctuation → dimmed.

/** Tokenize a JSON string into typed spans for coloring. */
function tokenize(json: string): { type: 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'ws'; text: string }[] {
	const tokens: { type: 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'ws'; text: string }[] = [];
	// Regex that captures JSON tokens in order
	const re =
		/("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([\[\]{}:,])|([ \t\n\r]+)/g;
	let match: RegExpExecArray | null;
	let lastIndex = 0;

	while ((match = re.exec(json)) !== null) {
		// Fill any gap (shouldn't happen with valid JSON, but just in case)
		if (match.index > lastIndex) {
			tokens.push({ type: 'ws', text: json.slice(lastIndex, match.index) });
		}
		if (match[1] !== undefined) {
			// Key (captured with trailing colon handled separately)
			tokens.push({ type: 'key', text: match[1] });
		} else if (match[2] !== undefined) {
			tokens.push({ type: 'string', text: match[2] });
		} else if (match[3] !== undefined) {
			tokens.push({ type: 'number', text: match[3] });
		} else if (match[4] !== undefined) {
			tokens.push({ type: 'boolean', text: match[4] });
		} else if (match[5] !== undefined) {
			tokens.push({ type: 'null', text: match[5] });
		} else if (match[6] !== undefined) {
			tokens.push({ type: 'punct', text: match[6] });
		} else if (match[7] !== undefined) {
			tokens.push({ type: 'ws', text: match[7] });
		}
		lastIndex = re.lastIndex;
	}

	if (lastIndex < json.length) {
		tokens.push({ type: 'ws', text: json.slice(lastIndex) });
	}

	return tokens;
}

const COLOR_MAP: Record<string, string> = {
	key: 'text-lv-cyan',
	string: 'text-lv-green',
	number: 'text-lv-purple',
	boolean: 'text-lv-peach',
	null: 'text-muted-foreground/50 italic',
	punct: 'text-muted-foreground/40',
	ws: '',
};

/** Render syntax-highlighted JSON inside a scrollable `<pre>`. */
export function JsonHighlight({ data }: { data: unknown }) {
	const json = JSON.stringify(data, null, 2);
	const tokens = tokenize(json);

	return (
		<pre className="rounded border border-border bg-background/50 p-2 text-[10px] font-data overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">
			{tokens.map((t, i) => {
				if (t.type === 'ws') return t.text;
				return (
					<span key={i} className={COLOR_MAP[t.type]}>
						{t.text}
					</span>
				);
			})}
		</pre>
	);
}
