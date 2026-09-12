import { and, cosineDistance, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { embedText } from "./embeddings";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentName: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  content: string;
  /** Cosine distance for a vector hit, lower is closer; absent for a lexical-only hit. */
  distance: number | null;
}

const VECTOR_LIMIT = 8;
const LEXICAL_LIMIT = 4;

/**
 * Hybrid retrieval scoped to one or more knowledge bases (searching "all" of
 * a user's knowledge bases is just this called with every id they own — see
 * app/api/chat/route.ts): pgvector cosine similarity (primary) unioned with a
 * Postgres full-text pass (keeps recall reasonable against the temporary
 * local embedding model — see lib/embeddings.ts). Deduplicates by chunk,
 * vector hits taking priority.
 */
export async function retrieveChunks(knowledgeBaseIds: string[], query: string): Promise<RetrievedChunk[]> {
  if (knowledgeBaseIds.length === 0) return [];

  const queryVector = await embedText(query);
  const distance = sql<number>`${cosineDistance(schema.documentChunks.embedding, queryVector)}`;

  const vectorHits = await db
    .select({
      chunkId: schema.documentChunks.id,
      documentId: schema.documentChunks.documentId,
      documentName: schema.documents.fileName,
      knowledgeBaseId: schema.documentChunks.knowledgeBaseId,
      knowledgeBaseName: schema.knowledgeBases.name,
      content: schema.documentChunks.content,
      distance,
    })
    .from(schema.documentChunks)
    .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
    .innerJoin(schema.knowledgeBases, eq(schema.documentChunks.knowledgeBaseId, schema.knowledgeBases.id))
    .where(inArray(schema.documentChunks.knowledgeBaseId, knowledgeBaseIds))
    .orderBy(distance)
    .limit(VECTOR_LIMIT);

  const seen = new Set(vectorHits.map((h) => h.chunkId));

  const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let lexicalHits: RetrievedChunk[] = [];
  if (terms.length > 0) {
    const doc = sql`to_tsvector('english', ${schema.documentChunks.content})`;
    const tsQuery = sql.join(
      terms.map((t) => sql`plainto_tsquery('english', ${t})`),
      sql` || `,
    );
    const rank = sql<number>`ts_rank(${doc}, (${tsQuery}))`;

    const rows = await db
      .select({
        chunkId: schema.documentChunks.id,
        documentId: schema.documentChunks.documentId,
        documentName: schema.documents.fileName,
        knowledgeBaseId: schema.documentChunks.knowledgeBaseId,
        knowledgeBaseName: schema.knowledgeBases.name,
        content: schema.documentChunks.content,
      })
      .from(schema.documentChunks)
      .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
      .innerJoin(schema.knowledgeBases, eq(schema.documentChunks.knowledgeBaseId, schema.knowledgeBases.id))
      .where(and(inArray(schema.documentChunks.knowledgeBaseId, knowledgeBaseIds), sql`${doc} @@ (${tsQuery})`))
      .orderBy(desc(rank))
      .limit(LEXICAL_LIMIT);

    lexicalHits = rows.filter((r) => !seen.has(r.chunkId)).map((r) => ({ ...r, distance: null }));
  }

  return [...vectorHits, ...lexicalHits];
}
