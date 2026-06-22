import { describe, it, expect, vi, afterEach } from 'vitest';
import completionsCommand from './completions.js';

describe('completions command', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('includes timeseries under supabase-analytics in bash output', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		await (completionsCommand as any).run({ args: { shell: 'bash' } });

		const output = logSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
		expect(output).toContain('supabase-analytics)');
		expect(output).toContain('events summary timeseries');
	});

	it('includes supabase timeseries completion entries in zsh output', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		await (completionsCommand as any).run({ args: { shell: 'zsh' } });

		const output = logSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
		expect(output).toContain('supabase-analytics)');
		expect(output).toContain("'timeseries:timeseries'");
	});

	it('includes supabase timeseries completion entries in fish output', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		await (completionsCommand as any).run({ args: { shell: 'fish' } });

		const output = logSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
		expect(output).toContain("complete -c gk -n '__fish_seen_subcommand_from supabase-analytics' -a 'timeseries' -d 'timeseries'");
	});
});
