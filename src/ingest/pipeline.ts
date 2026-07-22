import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import type { Mode1Output } from "./mode1.js";
import { structurePage } from "./mode1.js";
import { rasterizePages } from "./rasterize.js";

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
  const source = await upsertSource(options.sourceKey, options.title);

  // Idempotent rebuild: clear this source's graph + pages (cascades handle
  // misconceptions, seeds, and node<->objective edges).
  await db.delete(schema.knowledgeNodes).where(eq(schema.knowledgeNodes.sourceId, source.id));
  await db.delete(schema.objectives).where(eq(schema.objectives.sourceId, source.id));
  await db.delete(schema.pages).where(eq(schema.pages.sourceId, source.id));

  const totals = { pages: 0, nodes: 0, objectives: 0, seeds: 0, gaps: 0 };

  for await (const page of rasterizePages(pdfPath, options.sourceKey, config.PAGE_IMAGE_DIR)) {
    const [pageRow] = await db
      .insert(schema.pages)
      .values({
        sourceId: source.id,
        pageType: "visual",
        pageNumber: page.pageNumber,
        imageKey: page.imageKey,
      })
      .returning({ id: schema.pages.id });

    const structured = await structurePage(page.imageBase64);
    const counts = await persistGraph(source.id, pageRow!.id, structured);

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

async function upsertSource(sourceKey: string, title?: string) {
  const [source] = await db
    .insert(schema.sources)
    .values({ sourceKey, title: title ?? null, kind: "visual" })
    .onConflictDoUpdate({
      target: schema.sources.sourceKey,
      set: { title: title ?? null },
    })
    .returning();
  return source!;
}

/**
 * Persist one page's structured output. Code assigns every citation key from
 * the row's serial (`KN-<n>`, `OBJ-<n>`, `AI-<n>`) — the model never sees them.
 * All of a page's rows land in one transaction.
 */
async function persistGraph(
  sourceId: string,
  pageId: string,
  out: Mode1Output,
): Promise<{ nodes: number; objectives: number; seeds: number }> {
  return db.transaction(async (tx) => {
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
  });
}
