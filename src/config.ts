import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_GENERATE_MODEL: z.string().default("gemini-flash-lite-latest"),
  GEMINI_EMBED_MODEL: z.string().default("gemini-embedding-001"),
  PAGE_IMAGE_DIR: z.string().default("./data/pages"),
  RETRIEVE_TOP_K: z.coerce.number().int().positive().default(3),
  PORT: z.coerce.number().int().positive().default(3000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
