import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Embedding dimension. text-embedding-004 emits 768.
 * If you switch GEMINI_EMBED_MODEL, update this and re-run db:push.
 * Defined locally (not imported) so drizzle-kit can load this file standalone.
 */
const EMBED_DIM = 768;

/**
 * One row = one page image.
 *
 * The image is the content. `description` is a short text summary Gemini writes
 * from the image — used ONLY to find the page. When we answer, we send the real
 * page image, not this text. (This is the no-GPU stand-in for ColPali; swap in
 * true visual embeddings later.)
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** The deck / textbook this belongs to. */
    sourceId: text("source_id").notNull(),
    sourceTitle: text("source_title"),
    /** 1-based page number. */
    pageNumber: integer("page_number").notNull(),

    /** Path to the rasterized page image, handed to the generator verbatim. */
    imagePath: text("image_path").notNull(),

    /** Gemini's short description of the page. Search text, not shown to users. */
    description: text("description").notNull(),

    /** Embedding of `description`. This is what search compares against. */
    embedding: vector("embedding", { dimensions: EMBED_DIM }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("pages_embedding_hnsw").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    uniqueIndex("pages_source_page").on(t.sourceId, t.pageNumber),
  ],
);

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
