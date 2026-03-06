/**
 * Smoke tests — section 20: API Route 404s.
 */

import type { SmokeContext } from './helpers.js';
import { req, admin, section, assertStatus } from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	section('API 404s');

	const unknown1 = await req('GET', '/v1/unknown');
	assertStatus('unknown /v1/ route -> 404', unknown1, 404);

	const unknown2 = await req('POST', `/v1/zones/${ctx.ZONE}/unknown`);
	assertStatus('unknown zone sub-route -> 404', unknown2, 404);

	const unknown3 = await admin('GET', '/admin/nonexistent');
	assertStatus('unknown /admin/ route -> 404', unknown3, 404);
}
