import { Hono } from "hono";
import { purgeRoute, __testClearInflightCache } from "./routes/purge";
import { adminApp } from "./routes/admin";
import type { HonoEnv } from "./types";

// Re-export DO class — wrangler requires it from the main entrypoint
export { PurgeRateLimiter } from "./durable-object";

// Re-export for tests
export { __testClearInflightCache };

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", purgeRoute);
app.route("/admin", adminApp);

export default app;
