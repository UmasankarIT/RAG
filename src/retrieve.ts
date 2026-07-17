import { cosineDistance, eq, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db, schema } from "./db/index.js";
import { embed } from "./gemini.js";

export interface RetrievedPage {
  id: string;
  sourceId: string;
  sourceTitle: string | null;
  pageNumber: number;
  imagePath: string;
  /** Cosine distance to the query. Lower is closer. */
  distance: number;
}

export interface RetrieveOptions {
  topK?: number;
  /** Restrict to one deck/textbook. */
  sourceId?: string;
}

/**
 * Single-stage retrieval: embed the question, cosine search over page
 * descriptions, return the top K pages. (No two-stage rerank in the simple
 * build — add it back with ColPali when a GPU is available.)
 */
export async function retrieve(
  question: string,
  options: RetrieveOptions = {},
): Promise<RetrievedPage[]> {
  const topK = options.topK ?? config.RETRIEVE_TOP_K;
  const queryEmbedding = await embed(question);

  const distance = sql<number>`${cosineDistance(schema.pages.embedding, queryEmbedding)}`;

  const rows = await db
    .select({
      id: schema.pages.id,
      sourceId: schema.pages.sourceId,
      sourceTitle: schema.pages.sourceTitle,
      pageNumber: schema.pages.pageNumber,
      imagePath: schema.pages.imagePath,
      distance,
    })
    .from(schema.pages)
    .where(options.sourceId ? eq(schema.pages.sourceId, options.sourceId) : undefined)
    .orderBy(distance)
    .limit(topK);

  return rows;
}
