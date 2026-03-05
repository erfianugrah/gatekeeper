/**
 * Admin authentication middleware.
 * Gates all /admin/* routes via X-Admin-Key header (HMAC + timingSafeEqual).
 */

import type { Context, Next } from 'hono';
import { timingSafeEqual } from './crypto';
import type { HonoEnv } from './types';

/** Hono middleware that gates admin routes with X-Admin-Key. */
export async function adminAuth(c: Context<HonoEnv>, next: Next): Promise<Response | void> {
	const adminKey = c.req.header('X-Admin-Key');
	if (adminKey && (await timingSafeEqual(adminKey, c.env.ADMIN_KEY))) {
		await next();
		return;
	}

	return c.json(
		{ success: false, errors: [{ code: 401, message: 'Unauthorized' }] },
		401,
	);
}
