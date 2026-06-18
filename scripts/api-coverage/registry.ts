/**
 * Coverage provider registry.
 *
 * The single place new upstream APIs are registered. Both the drift refresh (`refresh.ts`)
 * and the hermetic coverage test (`test/api-coverage.test.ts`) iterate `PROVIDERS` — adding
 * a spec-backed upstream is one conforming module under `providers/` + one entry here + one
 * committed snapshot, never a bespoke bolt-on.
 *
 * Only Supabase is registered today: it is the one upstream the proxy fronts that has a live,
 * machine-readable OpenAPI doc and a real risk of silent endpoint drift. The S3/R2 surface is
 * a compile-time-total enum (`Record<S3OperationName, string>`) and the Cloudflare surface is a
 * hand-curated per-service subset (the rest of the CF API is intentionally out of scope) — adding
 * either as a "provider" would be a tautological self-check, not drift detection. See README.md
 * for how to add the next spec-backed upstream.
 */

import type { CoverageProvider } from './types';
import { supabaseProvider } from './providers/supabase';

export const PROVIDERS: CoverageProvider[] = [supabaseProvider];
