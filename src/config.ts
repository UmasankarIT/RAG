import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),

  // Claude — the only generation model. Used for Mode 1 structuring, the mode
  // router, and answer generation. See llm.ts for the single call boundary.
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),

  // ColPali page/query embedder (local Python service — added in a later slice).
  COLPALI_URL: z.string().url().default("http://localhost:8000"),

  // Local image storage. No S3 — the DB stores a key under this directory.
  PAGE_IMAGE_DIR: z.string().default("./data/pages"),

  // Two-stage retrieval tuning.
  COARSE_TOP_K: z.coerce.number().int().positive().default(100),
  RERANK_TOP_K: z.coerce.number().int().positive().default(5),

  PORT: z.coerce.number().int().positive().default(3000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/**
 * ColQwen2 / ColPali emit one 128-dim vector per image patch. The coarse page
 * vector is those patches mean-pooled, so it shares the dimension. Kept in sync
 * with EMBED_DIM in db/schema.ts (defined there separately so drizzle-kit can
 * load the schema without booting this config).
 */
export const PATCH_DIM = 128;
