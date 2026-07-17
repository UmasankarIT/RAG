import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { describeImage, embed } from "../gemini.js";
import { rasterize } from "./rasterize.js";

export interface IngestOptions {
  pdfPath: string;
  sourceId: string;
  title?: string;
}

/**
 * Ingest one PDF: rasterize -> describe each page -> embed -> store.
 *
 * Re-ingesting the same sourceId replaces its pages (upsert by source+page).
 */
export async function ingest(options: IngestOptions): Promise<number> {
  const { pdfPath, sourceId, title } = options;

  const pages = await rasterize(pdfPath, sourceId, config.PAGE_IMAGE_DIR);
  console.log(`  rasterized ${pages.length} pages`);

  for (const page of pages) {
    const description = await describeImage(page.imageBase64);
    const embedding = await embed(description);

    await db
      .insert(schema.pages)
      .values({
        sourceId,
        sourceTitle: title ?? null,
        pageNumber: page.pageNumber,
        imagePath: page.imagePath,
        description,
        embedding,
      })
      .onConflictDoUpdate({
        target: [schema.pages.sourceId, schema.pages.pageNumber],
        set: {
          imagePath: page.imagePath,
          description,
          embedding,
          sourceTitle: title ?? null,
        },
      });

    console.log(`  page ${page.pageNumber}/${pages.length} indexed`);
  }

  return pages.length;
}

export async function pageCount(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.pages)
    .where(sql`${schema.pages.sourceId} = ${sourceId}`);
  return row?.n ?? 0;
}
