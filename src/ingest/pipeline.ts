import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { colpaliHealthy, embedPages } from "../embed/colpali.js";
import type { Mode1Output } from "./mode1.js";
import { structurePage, structureTranscriptChunk } from "./mode1.js";
import { rasterizePages } from "./rasterize.js";
import { chunkSegments } from "./transcript.js";
import type { TranscriptSegment } from "./transcript.js";

/** Anything with the query-builder methods persistGraph/upsertSource need — either `db` itself, or an open transaction. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface IngestOptions {
  sourceKey: string;
  title?: string;
}

export interface IngestResult {
  sourceKey: string;
  pages: number;
  nodes: number;
  objectives: number;
  seeds: number;
  gaps: number;
}

/**
 * MODE 1 pipeline: PDF -> rasterize -> (store page) -> Claude structures ->
 * persist the 3H knowledge graph. Re-ingesting the same sourceKey rebuilds it
 * from scratch (idempotent), so there are no orphan nodes from a prior run.
 *
 * ColPali embedding of the page images is a separate slice — pages are written
 * with their image now; coarse/patch vectors get filled in later.
 */
export async function ingestPdf(
  pdfPath: string,
  options: IngestOptions,
): Promise<IngestResult> {
  const source = await upsertSource(db, options.sourceKey, options.title, "visual");

  // Idempotent rebuild: clear this source's graph + pages (cascades handle
  // misconceptions, seeds, and node<->objective edges).
  await db.delete(schema.knowledgeNodes).where(eq(schema.knowledgeNodes.sourceId, source.id));
  await db.delete(schema.objectives).where(eq(schema.objectives.sourceId, source.id));
  await db.delete(schema.pages).where(eq(schema.pages.sourceId, source.id));

  // ColPali is optional at ingest time: if the embedder is down we still build
  // the knowledge graph (Mode 1), just without vectors. Those pages aren't
  // retrievable until re-ingested with the embedder up.
  const embedderUp = await colpaliHealthy();
  if (!embedderUp) {
    console.warn(
      `  ColPali unreachable at ${config.COLPALI_URL} — structuring only, pages will have no vectors`,
    );
  }

  const totals = { pages: 0, nodes: 0, objectives: 0, seeds: 0, gaps: 0 };

  for await (const page of rasterizePages(pdfPath, options.sourceKey, config.PAGE_IMAGE_DIR)) {
    const image = Buffer.from(page.imageBase64, "base64");
    const embedding = embedderUp ? (await embedPages([image]))[0] : undefined;

    const [pageRow] = await db
      .insert(schema.pages)
      .values({
        sourceId: source.id,
        pageType: "visual",
        pageNumber: page.pageNumber,
        imageKey: page.imageKey,
        ...(embedding
          ? {
              coarseVector: embedding.coarse,
              patchVectors: embedding.patches,
              patchCount: embedding.patchCount,
            }
          : {}),
      })
      .returning({ id: schema.pages.id });

    const structured = await structurePage(page.imageBase64);
    const counts = await db.transaction((tx) => persistGraph(tx, source.id, pageRow!.id, structured));

    totals.pages += 1;
    totals.nodes += counts.nodes;
    totals.objectives += counts.objectives;
    totals.seeds += counts.seeds;
    totals.gaps += structured.gaps?.length ?? 0;

    console.log(
      `  page ${page.pageNumber}: ${counts.nodes} nodes, ${counts.objectives} objectives, ${counts.seeds} seeds`,
    );
    for (const gap of structured.gaps ?? []) {
      console.log(`    gap [${gap.vector ?? "?"}]: ${gap.description}`);
    }
  }

  return { sourceKey: options.sourceKey, ...totals };
}

/**
 * MODE 1 pipeline, transcript variant: caller hands in timestamped,
 * speaker-attributed segments (the shape a real transcript system produces —
 * no file parsing here). Segments are grouped into speaker-turn-bounded
 * chunks, each structured by Claude from text (no rasterization, no ColPali).
 *
 * Every chunk is structured BEFORE any DB write. Only once all of them have
 * succeeded does the source's graph get replaced, in one transaction — so a
 * failure partway through a re-ingest never leaves the source with a
 * half-deleted, half-rebuilt (or empty) knowledge graph; the old graph stays
 * intact until the new one is fully ready to swap in.
 */
export async function ingestTranscript(
  segments: TranscriptSegment[],
  options: IngestOptions,
): Promise<IngestResult> {
  const chunks = chunkSegments(segments);
  if (chunks.length === 0) {
    throw new Error("no non-empty segments to ingest");
  }

  const structuredChunks: Array<{ chunk: (typeof chunks)[number]; structured: Mode1Output }> = [];
  for (const chunk of chunks) {
    const structured = await structureTranscriptChunk(chunk);
    structuredChunks.push({ chunk, structured });

    const startS = Math.round(chunk.startMs / 1000);
    const endS = Math.round(chunk.endMs / 1000);
    console.log(
      `  chunk ${structuredChunks.length}/${chunks.length} [${startS}s-${endS}s, ${chunk.speakers.join(", ")}]: ` +
        `${structured.nodes.length} nodes, ${structured.objectives.length} objectives`,
    );
    for (const gap of structured.gaps ?? []) {
      console.log(`    gap [${gap.vector ?? "?"}]: ${gap.description}`);
    }
  }

  const totals = { pages: 0, nodes: 0, objectives: 0, seeds: 0, gaps: 0 };

  await db.transaction(async (tx) => {
    const source = await upsertSource(tx, options.sourceKey, options.title, "sequential");

    await tx.delete(schema.knowledgeNodes).where(eq(schema.knowledgeNodes.sourceId, source.id));
    await tx.delete(schema.objectives).where(eq(schema.objectives.sourceId, source.id));
    await tx.delete(schema.pages).where(eq(schema.pages.sourceId, source.id));

    for (const { chunk, structured } of structuredChunks) {
      const [pageRow] = await tx
        .insert(schema.pages)
        .values({
          sourceId: source.id,
          pageType: "sequential",
          textContent: chunk.text,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
        })
        .returning({ id: schema.pages.id });

      const counts = await persistGraph(tx, source.id, pageRow!.id, structured);

      totals.pages += 1;
      totals.nodes += counts.nodes;
      totals.objectives += counts.objectives;
      totals.seeds += counts.seeds;
      totals.gaps += structured.gaps?.length ?? 0;
    }
  });

  return { sourceKey: options.sourceKey, ...totals };
}

/**
 * Delete an ingested source and everything derived from it (pages, knowledge
 * nodes, objectives, seeds, misconceptions, node<->objective edges — all via
 * cascade on sources.id) plus its rasterized page images on disk (a no-op if
 * this source was a transcript, which has no image directory).
 */
export async function deleteSource(sourceKey: string): Promise<boolean> {
  const [deleted] = await db
    .delete(schema.sources)
    .where(eq(schema.sources.sourceKey, sourceKey))
    .returning({ id: schema.sources.id });

  if (!deleted) return false;

  await rm(path.join(config.PAGE_IMAGE_DIR, sourceKey), {
    recursive: true,
    force: true,
  });
  return true;
}

async function upsertSource(
  client: DbOrTx,
  sourceKey: string,
  title: string | undefined,
  kind: "visual" | "sequential",
) {
  const [source] = await client
    .insert(schema.sources)
    .values({ sourceKey, title: title ?? null, kind })
    .onConflictDoUpdate({
      target: schema.sources.sourceKey,
      set: { title: title ?? null, kind },
    })
    .returning();
  return source!;
}

/**
 * Persist one page's structured output. Code assigns every citation key from
 * the row's serial (`KN-<n>`, `OBJ-<n>`, `AI-<n>`) — the model never sees them.
 * Takes a `DbOrTx` rather than opening its own transaction, so callers control
 * the atomicity boundary — a single call for the PDF path (one page's graph is
 * atomic), or many calls sharing one outer transaction for the transcript path
 * (the whole source's graph is atomic).
 */
async function persistGraph(
  tx: DbOrTx,
  sourceId: string,
  pageId: string,
  out: Mode1Output,
): Promise<{ nodes: number; objectives: number; seeds: number }> {
  // --- nodes (index-aligned so objectives can reference them) ------------
  const nodeIds: string[] = [];
  for (const node of out.nodes) {
    const [row] = await tx
      .insert(schema.knowledgeNodes)
      .values({
        sourceId,
        pageId,
        vector: node.vector,
        nodeType: node.nodeType ?? null,
        title: node.title ?? null,
        content: node.content,
        knKey: randomUUID(), // temporary unique placeholder; set to KN-<seq> below
      })
      .returning({ id: schema.knowledgeNodes.id, seq: schema.knowledgeNodes.seq });

    await tx
      .update(schema.knowledgeNodes)
      .set({ knKey: `KN-${row!.seq}` })
      .where(eq(schema.knowledgeNodes.id, row!.id));

    nodeIds.push(row!.id);

    for (const m of node.misconceptions ?? []) {
      await tx.insert(schema.misconceptions).values({
        nodeId: row!.id,
        description: m.description,
        distractorLogic: m.distractorLogic ?? null,
      });
    }
  }

  // --- objectives + seeds + node links -----------------------------------
  let seedCount = 0;
  for (const objective of out.objectives) {
    const [row] = await tx
      .insert(schema.objectives)
      .values({
        sourceId,
        vector: objective.vector,
        taxonomyLevel: objective.taxonomyLevel ?? null,
        statement: objective.statement,
        objKey: randomUUID(),
      })
      .returning({ id: schema.objectives.id, seq: schema.objectives.seq });

    await tx
      .update(schema.objectives)
      .set({ objKey: `OBJ-${row!.seq}` })
      .where(eq(schema.objectives.id, row!.id));

    for (const seed of objective.seeds ?? []) {
      const [seedRow] = await tx
        .insert(schema.assessmentSeeds)
        .values({
          objectiveId: row!.id,
          itemType: seed.itemType ?? null,
          stem: seed.stem,
          aiKey: randomUUID(),
        })
        .returning({ id: schema.assessmentSeeds.id, seq: schema.assessmentSeeds.seq });

      await tx
        .update(schema.assessmentSeeds)
        .set({ aiKey: `AI-${seedRow!.seq}` })
        .where(eq(schema.assessmentSeeds.id, seedRow!.id));

      seedCount += 1;
    }

    for (const ref of objective.nodeRefs ?? []) {
      const nodeId = nodeIds[ref];
      if (!nodeId) continue; // model referenced a node index that doesn't exist
      await tx
        .insert(schema.nodeObjectives)
        .values({ nodeId, objectiveId: row!.id })
        .onConflictDoNothing();
    }
  }

  return { nodes: out.nodes.length, objectives: out.objectives.length, seeds: seedCount };
}
