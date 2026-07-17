import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { closeDb, db, schema } from "./db/index.js";
import { answer, type AnswerPage } from "./gemini.js";
import { retrieve } from "./retrieve.js";
import { indexHtml } from "./ui.js";

const app = Fastify({ logger: true });

/** The web UI. */
app.get("/", async (_request, reply) => {
  return reply.type("text/html").send(indexHtml);
});

/** Serve a rasterized page image, so the UI can show cited pages. */
app.get("/image", async (request, reply) => {
  const parsed = z
    .object({ sourceId: z.string().min(1), pageNumber: z.coerce.number().int().positive() })
    .safeParse(request.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const { sourceId, pageNumber } = parsed.data;

  const [page] = await db
    .select({ imagePath: schema.pages.imagePath })
    .from(schema.pages)
    .where(and(eq(schema.pages.sourceId, sourceId), eq(schema.pages.pageNumber, pageNumber)))
    .limit(1);

  if (!page) {
    return reply.code(404).send({ error: `no page ${pageNumber} in ${sourceId}` });
  }

  const bytes = await readFile(page.imagePath);
  return reply.type("image/png").send(bytes);
});

const querySchema = z.object({
  question: z.string().min(1),
  sourceId: z.string().optional(),
  topK: z.number().int().positive().max(10).optional(),
});

/**
 * Ask a question. Full path: embed -> cosine search -> generate from images.
 */
app.post("/query", async (request, reply) => {
  const parsed = querySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const { question, sourceId, topK } = parsed.data;

  const pages = await retrieve(question, {
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(topK !== undefined ? { topK } : {}),
  });

  if (pages.length === 0) {
    return {
      answer: "I could not find anything in the course material that covers this.",
      citations: [],
    };
  }

  const answerPages: AnswerPage[] = await Promise.all(
    pages.map(async (p) => ({
      sourceId: p.sourceId,
      sourceTitle: p.sourceTitle,
      pageNumber: p.pageNumber,
      imageBase64: (await readFile(p.imagePath)).toString("base64"),
    })),
  );

  const text = await answer(question, answerPages);

  return {
    answer: text,
    citations: pages.map((p) => ({
      sourceId: p.sourceId,
      sourceTitle: p.sourceTitle,
      pageNumber: p.pageNumber,
      imagePath: p.imagePath,
      distance: p.distance,
    })),
  };
});

/**
 * List everything that has been ingested, grouped by source. Open in a browser:
 * http://localhost:3000/sources
 */
app.get("/sources", async () => {
  const rows = await db
    .select({
      sourceId: schema.pages.sourceId,
      sourceTitle: schema.pages.sourceTitle,
      pages: sql<number>`count(*)::int`,
      addedAt: sql<string>`min(${schema.pages.createdAt})`,
    })
    .from(schema.pages)
    .groupBy(schema.pages.sourceId, schema.pages.sourceTitle)
    .orderBy(sql`min(${schema.pages.createdAt})`);

  return { count: rows.length, sources: rows };
});

app.get("/health", async () => ({ status: "ok" }));

async function main(): Promise<void> {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await closeDb();
      process.exit(0);
    })();
  });
}

main().catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
