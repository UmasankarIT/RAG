import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { closeDb } from "./db/index.js";
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
      },
    });
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
