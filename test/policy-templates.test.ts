import { describe, it, expect } from 'vitest';
import { validatePolicy } from '../src/policy-engine';
import {
	POLICY_TEMPLATES,
	S3_POLICY_TEMPLATES,
	applyTemplate,
	groupTemplates,
	type PolicyTemplate,
} from '../dashboard/src/lib/policy-templates';

// Representative default resources per scope (as KeysPage's buildDefaultResources would emit).
const CTX_RESOURCES: Record<string, string[]> = {
	zone: ['zone:0123456789abcdef0123456789abcdef'],
	account: ['account:25f21f141824546aa72c74451a11b419'],
	supabase: ['project:abcdefghij1234567890'],
	supabase_metrics: ['project:abcdefghij1234567890'],
	s3: ['*'],
};

// Known action prefixes across every fronted surface.
const KNOWN_PREFIXES = new Set(['purge', 'dns', 'd1', 'kv', 'workers', 'queues', 'vectorize', 'hyperdrive', 'supabase', 's3']);
const ACTION_RE = /^[a-z0-9_]+(:(\*|[A-Za-z0-9_]+))+$/;

function assertTemplateValid(t: PolicyTemplate, resources: string[]) {
	// Build with real resources AND with an empty ctx (placeholder path). Both must be valid.
	for (const ctx of [{ resources }, { resources: [] }]) {
		const policy = applyTemplate(t, ctx);
		expect(policy.version, `${t.id} version`).toBe('2025-01-01');
		expect(policy.statements.length, `${t.id} has statements`).toBeGreaterThan(0);

		const errors = validatePolicy(policy);
		expect(errors, `${t.id} validatePolicy errors: ${JSON.stringify(errors)}`).toEqual([]);

		for (const stmt of policy.statements) {
			expect(stmt._id, `${t.id} statement has _id`).toBeTruthy();
			expect(stmt.resources.length, `${t.id} resources non-empty`).toBeGreaterThan(0);
			for (const a of stmt.actions) {
				expect(ACTION_RE.test(a), `${t.id} action shape: ${a}`).toBe(true);
				expect(KNOWN_PREFIXES.has(a.split(':')[0]), `${t.id} known prefix: ${a}`).toBe(true);
			}
		}
	}
}

describe('policy templates', () => {
	for (const [scope, templates] of Object.entries(POLICY_TEMPLATES)) {
		describe(`scope: ${scope}`, () => {
			it('has at least one template', () => {
				expect(templates.length).toBeGreaterThan(0);
			});

			it('template ids are unique', () => {
				const ids = templates.map((t) => t.id);
				expect(new Set(ids).size).toBe(ids.length);
			});

			for (const t of templates) {
				it(`${t.id} produces a valid policy`, () => {
					assertTemplateValid(t, CTX_RESOURCES[scope]);
				});
			}
		});
	}

	describe('scope: s3', () => {
		it('template ids are unique', () => {
			const ids = S3_POLICY_TEMPLATES.map((t) => t.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		for (const t of S3_POLICY_TEMPLATES) {
			it(`${t.id} produces a valid policy`, () => {
				assertTemplateValid(t, CTX_RESOURCES.s3);
			});
		}
	});

	it('applyTemplate fills resources from the token context', () => {
		const t = POLICY_TEMPLATES.supabase.find((x) => x.id === 'sb-full')!;
		const policy = applyTemplate(t, { resources: ['project:abcdefghij1234567890'] });
		expect(policy.statements[0].resources).toEqual(['project:abcdefghij1234567890']);
	});

	it('applyTemplate substitutes a placeholder when no resources are given', () => {
		const t = POLICY_TEMPLATES.zone.find((x) => x.id === 'purge-full')!;
		const policy = applyTemplate(t, { resources: [] });
		expect(policy.statements[0].resources).toEqual(['zone:<zone-id>']);
	});

	it('groupTemplates preserves first-seen group order', () => {
		const groups = groupTemplates(POLICY_TEMPLATES.zone);
		expect(groups.map((g) => g.group)).toEqual(['Purge', 'DNS']);
	});
});
