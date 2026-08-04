import { readFile } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { closeDb } from "./db/index.js";
import { assessAskBatch, assessGrade } from "./modes/assess.js";
import { teach } from "./modes/teach.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/health", async () => ({ status: "ok" }));

const teachBody = z.object({
  learnerExtKey: z.string().min(1),
  topic: z.string().min(1),
  sourceKey: z.string().optional(),
  drafts: z.boolean().optional(),
});

app.post("/api/teach", async (request, reply) => {
  const parsed = teachBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: parsed.error.flatten().fieldErrors });
  }
  const { learnerExtKey, topic, sourceKey, drafts } = parsed.data;

  try {
    const result = await teach(learnerExtKey, topic, {
      reviewedOnly: !drafts,
      ...(sourceKey ? { sourceKey } : {}),
    });
    return reply.send({
      ok: true,
      data: {
        answer: result.text,
        citations: result.citations,
        unknownCitations: result.unknownCitations,
        nodesUsed: result.nodesUsed,
        usedVisual: result.usedVisual,
        scheduledReview: result.scheduledReview,
        grounded: result.grounded,
        smallTalk: result.smallTalk,
        sections: result.sections ?? null,
        imageKey: result.imageKey ?? null,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ ok: false, error: message });
  }
});

/**
 * Serve a rasterized page image by its imageKey (e.g. "ckd/page-0001.png"),
 * the same relative path stored in `pages.imageKey` under PAGE_IMAGE_DIR — the
 * "corresponding image" shown alongside a teaching answer. Resolves and
 * checks the path stays inside PAGE_IMAGE_DIR before reading (no traversal
 * outside the image root, even though imageKey values come from our own DB).
 */
app.get("/api/pages/*", async (request, reply) => {
  const wildcard = (request.params as { "*": string })["*"];
  if (!wildcard) {
    return reply.code(400).send({ ok: false, error: "missing image path" });
  }

  const root = path.resolve(config.PAGE_IMAGE_DIR);
  const resolved = path.resolve(root, wildcard);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return reply.code(400).send({ ok: false, error: "invalid image path" });
  }

  try {
    const buf = await readFile(resolved);
    return reply.type("image/png").send(buf);
  } catch {
    return reply.code(404).send({ ok: false, error: "image not found" });
  }
});

const assessAskBody = z.object({
  topic: z.string().min(1),
  sourceKey: z.string().optional(),
  drafts: z.boolean().optional(),
  /** How many distinct quiz questions to generate. Defaults to a real quiz, not one question. */
  count: z.number().int().min(1).max(10).optional(),
});

app.post("/api/assess/ask", async (request, reply) => {
  const parsed = assessAskBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: parsed.error.flatten().fieldErrors });
  }
  const { topic, sourceKey, drafts, count } = parsed.data;

  try {
    const items = await assessAskBatch(topic, count ?? 5, {
      reviewedOnly: !drafts,
      ...(sourceKey ? { sourceKey } : {}),
    });
    return reply.send({ ok: true, data: items });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ ok: false, error: message });
  }
});

const assessGradeBody = z.object({
  itemKey: z.string().min(1),
  learnerExtKey: z.string().min(1),
  response: z.string().min(1),
});

app.post("/api/assess/grade", async (request, reply) => {
  const parsed = assessGradeBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: parsed.error.flatten().fieldErrors });
  }
  const { itemKey, learnerExtKey, response } = parsed.data;

  try {
    const grade = await assessGrade(itemKey, learnerExtKey, response);
    return reply.send({ ok: true, data: grade });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ ok: false, error: message });
  }
});

async function shutdown(): Promise<void> {
  await app.close();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
