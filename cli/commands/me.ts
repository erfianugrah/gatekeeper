import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import { info, bold, dim, cyan, green, label, printJson, formatDuration } from '../ui.js';
import { baseArgs } from '../shared-args.js';

export default defineCommand({
	meta: {
		name: 'me',
		description: 'Show current user identity and role',
	},
	args: { ...baseArgs },
	async run({ args }) {
		const config = resolveConfig(args);

		const { status, data, durationMs } = await request(config, 'GET', '/admin/me', {
			auth: 'admin',
			label: 'Checking identity...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		info(`Identity ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		label('Email', result.email ? bold(result.email as string) : dim('none'));
		label('Role', green(bold(result.role as string)));
		label('Auth method', cyan(result.authMethod as string));
		const groups = result.groups as string[];
		if (groups.length > 0) {
			label('Groups', groups.join(', '));
		}
		if (result.logoutUrl) {
			label('Logout URL', dim(result.logoutUrl as string));
		}
		console.error('');
	},
});
