/**
 * Coverage provider registry.
 *
 * The single place new upstream APIs are registered. Both the drift refresh (`refresh.ts`)
 * and the hermetic coverage test (`test/api-coverage.test.ts`) iterate `PROVIDERS` — adding
 * an upstream is one conforming module under `providers/` + one entry here + one committed
 * snapshot, never a bespoke bolt-on.
 *
 * Each fronted upstream is covered by the model that fits its surface (see README.md):
 *   - supabase   — live OpenAPI spec vs the `classifySupabaseRequest` classifier.
 *   - s3         — runtime operation enum vs the real `detectOperation` routing.
 *   - cloudflare — live CF OpenAPI spec (filtered to proxied resources) vs the real Hono routes.
 */

import type { CoverageProvider } from './types';
import { supabaseProvider } from './providers/supabase';
import { s3Provider } from './providers/s3';
import { cloudflareProvider } from './providers/cloudflare';

export const PROVIDERS: CoverageProvider[] = [supabaseProvider, s3Provider, cloudflareProvider];
