import "dotenv/config";
import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.string().url(),

    // Which LLM backend the modes run on. Claude is the target; Gemini is a
    // temporary stand-in for testing before a Claude key is available. The
    // modes never see this — llm.ts dispatches. Swapping is a one-line change.
    LLM_PROVIDER: z.enum(["claude", "gemini"]).default("claude"),

    // Claude (Anthropic) — the intended backend.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),

    // Gemini (Google) — testing stand-in only.
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-flash-lite-latest"),

    // ColPali page/query embedder (local Python service).
    COLPALI_URL: z.string().url().default("http://localhost:8000"),

    // Local image storage. No S3 — the DB stores a key under this directory.
    PAGE_IMAGE_DIR: z.string().default("./data/pages"),

    // Two-stage retrieval tuning.
    COARSE_TOP_K: z.coerce.number().int().positive().default(100),
    RERANK_TOP_K: z.coerce.number().int().positive().default(5),

    PORT: z.coerce.number().int().positive().default(3000),
  })
  .superRefine((env, ctx) => {
    // Only the active provider's key is required.
    if (env.LLM_PROVIDER === "claude" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "required when LLM_PROVIDER=claude",
      });
    }
    if (env.LLM_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GEMINI_API_KEY"],
        message: "required when LLM_PROVIDER=gemini",
      });
    }
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
