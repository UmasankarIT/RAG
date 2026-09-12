import { config as loadEnv } from "dotenv";
import { z } from "zod";

// Next.js already loads .env.local for its own server runtime; this is only
// load-bearing for standalone scripts (drizzle-kit, etc.) run outside Next.
// dotenv never overwrites a variable that's already set, so this is a no-op
// when Next has already populated process.env.
loadEnv({ path: ".env.local" });

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),

  // Chat generation — Groq (hosted, free tier, no local load).
  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),

  // File storage — Supabase Storage (hosted, free tier, no local disk usage).
  SUPABASE_URL: z.string().min(1),
  // The service_role key, NOT the public anon key — server routes act as a
  // trusted backend and need full access, not the RLS-restricted client key.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_BUCKET: z.string().default("documents"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration — check .env.local against .env.local.example");
}

export const config = parsed.data;

/** Dimension of the embedding vector stored in `documentChunks.embedding`. Kept
 * in sync with the model in `lib/embeddings.ts` and the local copy of this
 * constant in `lib/db/schema.ts` (duplicated there so drizzle-kit can load
 * the schema without booting full env validation) — change all three together. */
export const EMBEDDING_DIM = 384;
