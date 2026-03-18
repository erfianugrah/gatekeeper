/** Shell completion script generator for gk CLI. */

import { defineCommand } from 'citty';
import { info, bold, dim, cyan, error } from '../ui.js';

// ─── Command tree ───────────────────────────────────────────────────────────
// Flat list of commands + subcommands for completion generation.

const COMMANDS: Record<string, string[]> = {
	gk: [
		'health',
		'keys',
		'purge',
		'analytics',
		's3-credentials',
		's3-analytics',
		'dns-analytics',
		'cf-analytics',
		'upstream-tokens',
		'upstream-r2',
		'config',
		'audit',
		'me',
		'completions',
	],
	keys: ['create', 'list', 'get', 'rotate', 'update', 'revoke', 'bulk-revoke', 'bulk-delete'],
	purge: ['hosts', 'tags', 'prefixes', 'urls', 'everything'],
	's3-credentials': ['create', 'list', 'get', 'rotate', 'update', 'revoke', 'bulk-revoke', 'bulk-delete'],
	'upstream-tokens': ['create', 'list', 'get', 'update', 'delete', 'bulk-delete'],
	'upstream-r2': ['create', 'list', 'get', 'update', 'delete', 'bulk-delete'],
	analytics: ['events', 'summary'],
	's3-analytics': ['events', 'summary'],
	'dns-analytics': ['events', 'summary'],
	'cf-analytics': ['events', 'summary'],
	config: ['get', 'set', 'reset'],
	audit: ['events'],
};

const GLOBAL_FLAGS = ['--endpoint', '--admin-key', '--json', '--help'];
const ZONE_FLAGS = ['--zone-id', '-z'];

// ─── Bash completion ────────────────────────────────────────────────────────

function generateBash(): string {
	const subcommandList = COMMANDS['gk'].join(' ');
	const cases: string[] = [];

	for (const [parent, subs] of Object.entries(COMMANDS)) {
		if (parent === 'gk') continue;
		cases.push(
			`        ${parent})\n            COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") )\n            return 0\n            ;;`,
		);
	}

	return `# gk bash completion — add to ~/.bashrc or ~/.bash_completion
# eval "$(gk completions bash)"

_gk_completions() {
    local cur prev words cword
    _init_completion || return

    local subcommands="${subcommandList}"
    local global_flags="${[...GLOBAL_FLAGS, ...ZONE_FLAGS].join(' ')}"

    # Completing the first argument (subcommand)
    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$subcommands" -- "$cur") )
        return 0
    fi

    # Completing the second argument (sub-subcommand)
    if [[ $cword -eq 2 ]]; then
        case "\${words[1]}" in
${cases.join('\n')}
        esac
    fi

    # Flag completion
    if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "$global_flags --force --name --key-id --access-key-id --policy --upstream-token-id --expires-in-days --active-only --permanent --account-scoped" -- "$cur") )
        return 0
    fi
}

complete -F _gk_completions gk
`;
}

// ─── Zsh completion ─────────────────────────────────────────────────────────

function generateZsh(): string {
	const subcommandList = COMMANDS['gk'].map((c) => `'${c}:${c} management'`).join('\n            ');
	const cases: string[] = [];

	for (const [parent, subs] of Object.entries(COMMANDS)) {
		if (parent === 'gk') continue;
		const subList = subs.map((s) => `'${s}:${s}'`).join(' ');
		cases.push(`        ${parent})\n            _describe 'subcommand' "(${subList})"\n            ;;`);
	}

	return `#compdef gk
# gk zsh completion — add to your fpath
# eval "$(gk completions zsh)"

_gk() {
    local -a commands
    commands=(
            ${subcommandList}
    )

    _arguments -C \\
        '1:command:->command' \\
        '2:subcommand:->subcommand' \\
        '*::options:->options'

    case $state in
    command)
        _describe 'command' commands
        ;;
    subcommand)
        case $words[2] in
${cases.join('\n')}
        esac
        ;;
    options)
        _arguments \\
            '--endpoint[Gateway URL]:url:' \\
            '--admin-key[Admin key]:key:' \\
            '--json[Output raw JSON]' \\
            '--zone-id[Cloudflare zone ID]:zone:' \\
            '--force[Skip confirmation]' \\
            '--name[Entity name]:name:' \\
            '--policy[Policy JSON or @file]:policy:_files' \\
            '--upstream-token-id[Upstream token ID]:id:' \\
            '--expires-in-days[Expiry in days]:days:' \\
            '--help[Show help]'
        ;;
    esac
}

_gk
`;
}

// ─── Fish completion ────────────────────────────────────────────────────────

function generateFish(): string {
	const lines: string[] = [
		'# gk fish completion — add to ~/.config/fish/completions/gk.fish',
		'# gk completions fish > ~/.config/fish/completions/gk.fish',
		'',
		'# Disable file completions by default',
		'complete -c gk -f',
		'',
		'# Top-level subcommands',
	];

	for (const cmd of COMMANDS['gk']) {
		lines.push(`complete -c gk -n '__fish_use_subcommand' -a '${cmd}' -d '${cmd}'`);
	}

	lines.push('');
	lines.push('# Sub-subcommands');

	for (const [parent, subs] of Object.entries(COMMANDS)) {
		if (parent === 'gk') continue;
		for (const sub of subs) {
			lines.push(`complete -c gk -n '__fish_seen_subcommand_from ${parent}' -a '${sub}' -d '${sub}'`);
		}
	}

	lines.push('');
	lines.push('# Global flags');
	lines.push(`complete -c gk -l endpoint -d 'Gateway URL'`);
	lines.push(`complete -c gk -l admin-key -d 'Admin key'`);
	lines.push(`complete -c gk -l json -d 'Output raw JSON'`);
	lines.push(`complete -c gk -l zone-id -s z -d 'Cloudflare zone ID'`);
	lines.push(`complete -c gk -l force -s f -d 'Skip confirmation'`);
	lines.push(`complete -c gk -l help -d 'Show help'`);
	lines.push(`complete -c gk -l name -d 'Entity name'`);
	lines.push(`complete -c gk -l policy -d 'Policy JSON or @file'`);
	lines.push(`complete -c gk -l upstream-token-id -d 'Upstream token ID'`);
	lines.push(`complete -c gk -l expires-in-days -d 'Expiry in days'`);
	lines.push('');

	return lines.join('\n');
}

// ─── Command ────────────────────────────────────────────────────────────────

export default defineCommand({
	meta: {
		name: 'completions',
		description: 'Generate shell completion scripts (bash, zsh, fish)',
	},
	args: {
		shell: {
			type: 'positional',
			description: 'Shell type: bash, zsh, or fish',
			required: false,
		},
	},
	async run({ args }) {
		const shell = (args.shell as string) || '';

		switch (shell) {
			case 'bash':
				console.log(generateBash());
				break;
			case 'zsh':
				console.log(generateZsh());
				break;
			case 'fish':
				console.log(generateFish());
				break;
			default:
				console.error('');
				info(`Generate shell completion scripts for ${bold('gk')}`);
				console.error('');
				console.error(`  ${bold('Usage:')}`);
				console.error(`    ${cyan('gk completions bash')}  ${dim('# Add to ~/.bashrc')}`);
				console.error(`    ${cyan('gk completions zsh')}   ${dim('# Add to fpath')}`);
				console.error(`    ${cyan('gk completions fish')}  ${dim('# Add to ~/.config/fish/completions/')}`);
				console.error('');
				console.error(`  ${bold('Quick setup:')}`);
				console.error(`    ${dim('Bash:')}  ${cyan('eval "$(gk completions bash)"')}`);
				console.error(`    ${dim('Zsh:')}   ${cyan('eval "$(gk completions zsh)"')}`);
				console.error(`    ${dim('Fish:')}  ${cyan('gk completions fish > ~/.config/fish/completions/gk.fish')}`);
				console.error('');
				if (!shell) {
					// No argument provided — show usage, don't error
				} else {
					error(`Unknown shell "${shell}". Use bash, zsh, or fish.`);
				}
		}
	},
});
