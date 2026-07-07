import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PolicyDocument } from '@/lib/api';
import { applyTemplate, groupTemplates, type PolicyTemplate, type TemplateContext } from '@/lib/policy-templates';
import { T } from '@/lib/typography';

interface PolicyTemplateMenuProps {
	templates: PolicyTemplate[];
	/** Default resources for the selected token (fills each template's resources). */
	ctx: TemplateContext;
	/** Called with the fully-built policy when a template is chosen. Replaces the current policy. */
	onApply: (policy: PolicyDocument) => void;
}

/**
 * Compact template picker for the policy builders. Rendered as a Select used as
 * a one-shot action menu: choosing an item builds the template into a full
 * policy and hands it to `onApply`, then remounts (via `nonce`) so the trigger
 * returns to its placeholder instead of showing the last selection.
 */
export function PolicyTemplateMenu({ templates, ctx, onApply }: PolicyTemplateMenuProps) {
	const [nonce, setNonce] = useState(0);
	if (templates.length === 0) return null;
	const groups = groupTemplates(templates);

	return (
		<Select
			key={nonce}
			onValueChange={(id) => {
				const t = templates.find((x) => x.id === id);
				if (!t) return;
				onApply(applyTemplate(t, ctx));
				setNonce((n) => n + 1);
			}}
		>
			<SelectTrigger className="h-8 w-[200px] text-xs" aria-label="Start from template">
				<span className="flex items-center gap-1.5 text-muted-foreground">
					<Sparkles className="h-3 w-3" />
					<SelectValue placeholder="Start from template..." />
				</span>
			</SelectTrigger>
			<SelectContent className="max-h-[60vh]">
				{groups.map(({ group, items }) => (
					<SelectGroup key={group}>
						<SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{group}</SelectLabel>
						{items.map((t) => (
							<SelectItem key={t.id} value={t.id} className="text-xs">
								<span className="flex flex-col gap-0.5 py-0.5">
									<span className="font-medium">{t.label}</span>
									<span className={cnMuted}>{t.description}</span>
								</span>
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}

const cnMuted = `${T.muted} max-w-[240px] whitespace-normal leading-snug`;
