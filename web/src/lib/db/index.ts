import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

// A module-level singleton, cached on `globalThis` in dev so Next.js's hot
// reload doesn't open a fresh Postgres connection pool on every file save.
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };

// Hosted Postgres (Supabase, Neon, etc.) requires TLS; a local/Docker
// connection doesn't offer it at all. `require` only when the host isn't
// local, rather than hardcoding one or the other.
const isLocal = /localhost|127\.0\.0\.1/.test(config.DATABASE_URL);

const client =
  globalForDb.pgClient ??
  postgres(config.DATABASE_URL, {
    max: 10,
    onnotice: () => {},
    ssl: isLocal ? undefined : "require",
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pgClient = client;
}

export const db = drizzle(client, { schema });
export { schema };
