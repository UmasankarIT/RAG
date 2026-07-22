import { and, cosineDistance, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { embedQuery } from "../embed/colpali.js";
import { maxSim, toWords } from "./maxsim.js";

/** A knowledge node cited on a retrieved page. */
export interface CitedNode {
  knKey: string;
  vector: string;
  title: string | null;
  content: string;
}

export interface RetrievedPage {
  pageId: string;
  sourceKey: string;
  sourceTitle: string | null;
  pageNumber: number | null;
  imageKey: string;
  /** Stage 1 cosine distance over the pooled vector. Lower is closer. */
  coarseDistance: number;
  /** Stage 2 late-interaction score. Higher is better. */
  score: number;
  /** Reviewed KN-nodes on this page — the citable content (R0.1). */
  nodes: CitedNode[];
}

export interface RetrieveOptions {
  coarseTopK?: number;
  topK?: number;
  /** Restrict to one deck/textbook by its sourceKey. */
  sourceKey?: string;
  /** Only cite faculty-reviewed nodes. Defaults to true. */
  reviewedOnly?: boolean;
}

/**
 * Two-stage retrieval.
 *
 *   1. Coarse: HNSW over pooled page vectors -> top N candidates.
 *   2. Rerank: MaxSim over patch vectors     -> top K pages.
 *
 * Stage 1 bounds the whole system: stage 2 can only reorder what stage 1
 * returns, so a page missing from the candidate set is unreachable no matter
 * how good the reranker is. Track its recall separately.
 */
export async function retrieve(
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedPage[]> {
  const coarseTopK = options.coarseTopK ?? config.COARSE_TOP_K;
  const topK = options.topK ?? config.RERANK_TOP_K;
  const reviewedOnly = options.reviewedOnly ?? true;

  const embedding = await embedQuery(query);

  // --- Stage 1: coarse HNSW ----------------------------------------------
  const distance = sql<number>`${cosineDistance(schema.pages.coarseVector, embedding.coarse)}`;

  const candidates = await db
    .select({
      pageId: schema.pages.id,
      sourceId: schema.pages.sourceId,
      sourceKey: schema.sources.sourceKey,
      sourceTitle: schema.sources.title,
      pageNumber: schema.pages.pageNumber,
      imageKey: schema.pages.imageKey,
      patchVectors: schema.pages.patchVectors,
      patchCount: schema.pages.patchCount,
      coarseDistance: distance,
    })
    .from(schema.pages)
    .innerJoin(schema.sources, eq(schema.pages.sourceId, schema.sources.id))
    .where(
      and(
        eq(schema.pages.pageType, "visual"),
        isNotNull(schema.pages.coarseVector),
        ...(options.sourceKey ? [eq(schema.sources.sourceKey, options.sourceKey)] : []),
      ),
    )
    .orderBy(distance)
    .limit(coarseTopK);

  if (candidates.length === 0) return [];

  // --- Stage 2: MaxSim rerank --------------------------------------------
  const queryWords = toWords(embedding.patches);

  const scored = candidates
    .filter((c) => c.patchVectors && c.patchCount && c.imageKey)
    .map((c) => ({
      c,
      score: maxSim(
        queryWords,
        embedding.patchCount,
        toWords(c.patchVectors!),
        c.patchCount!,
        embedding.dim,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (scored.length === 0) return [];

  // --- Attach citable KN-nodes for the winning pages ---------------------
  const pageIds = scored.map((s) => s.c.pageId);
  const nodeRows = await db
    .select({
      pageId: schema.knowledgeNodes.pageId,
      knKey: schema.knowledgeNodes.knKey,
      vector: schema.knowledgeNodes.vector,
      title: schema.knowledgeNodes.title,
      content: schema.knowledgeNodes.content,
    })
    .from(schema.knowledgeNodes)
    .where(
      and(
        inArray(schema.knowledgeNodes.pageId, pageIds),
        ...(reviewedOnly ? [eq(schema.knowledgeNodes.status, "reviewed")] : []),
      ),
    );

  const nodesByPage = new Map<string, CitedNode[]>();
  for (const n of nodeRows) {
    if (!n.pageId) continue;
    const list = nodesByPage.get(n.pageId) ?? [];
    list.push({ knKey: n.knKey, vector: n.vector, title: n.title, content: n.content });
    nodesByPage.set(n.pageId, list);
  }

  return scored.map(({ c, score }) => ({
    pageId: c.pageId,
    sourceKey: c.sourceKey,
    sourceTitle: c.sourceTitle,
    pageNumber: c.pageNumber,
    imageKey: c.imageKey!,
    coarseDistance: c.coarseDistance,
    score,
    nodes: nodesByPage.get(c.pageId) ?? [],
  }));
}
