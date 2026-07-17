import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { closeDb, db, schema } from "../db/index.js";

/**
 * Delete ALL ingested data: every page row, and the rasterized image files.
 * Usage: npm run clear
 */
async function main(): Promise<void> {
  const [before] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.pages);

  await db.delete(schema.pages);
  console.log(`Deleted ${before?.n ?? 0} pages from the database.`);

  await rm(config.PAGE_IMAGE_DIR, { recursive: true, force: true });
  console.log(`Removed image files in ${config.PAGE_IMAGE_DIR}.`);
  console.log("All ingested data cleared.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
