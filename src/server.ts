import { readFile } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { asc, eq } from "drizzle-orm";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import sharp from "sharp";
import { z } from "zod";
import { config } from "./config.js";
import { closeDb, db, schema } from "./db/index.js";
import { assessAskBatch, assessGrade, assessGradeBatch } from "./modes/assess.js";
import { generateCurriculum } from "./modes/curriculum.js";
import { generateFeedback } from "./modes/feedback.js";
import { teach } from "./modes/teach.js";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(cors, { origin: true });

await app.register(swagger, {
  openapi: {
    info: {
      title: "3H Pedagogical Agent API",
      description: "Teach / Assess / Feedback / Curriculum modes over the visual RAG backend.",
      version: "0.1.0",
    },
  },
  transform: jsonSchemaTransform,
});

await app.register(swaggerUi, {
  routePrefix: "/docs",
});

app.get("/health", { schema: { tags: ["health"] } }, async () => ({ status: "ok" }));

const teachBody = z.object({
  learnerExtKey: z.string().min(1),
  topic: z.string().min(1),
  sourceKey: z.string().optional(),
  drafts: z.boolean().optional(),
});

app.post(
  "/api/teach",
  {
    schema: {
      tags: ["teach"],
      summary: "Mode 3 — Teach: ask a question, get a grounded answer",
      body: teachBody,
    },
  },
  async (request, reply) => {
    const { learnerExtKey, topic, sourceKey, drafts } = request.body;

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
  },
);

const chatHistoryQuery = z.object({
  learnerExtKey: z.string().min(1),
});

/**
 * Fetch a learner's persisted Teach conversation (§4 session_history) — the
 * server-side record that survives a device/browser switch, unlike the
 * frontend's localStorage copy. Written automatically by every `teach()` call
 * (see modes/teach.ts); this is the read side only.
 */
app.get(
  "/api/chat/history",
  {
    schema: {
      tags: ["teach"],
      summary: "Fetch a learner's persisted Teach conversation",
      querystring: chatHistoryQuery,
    },
  },
  async (request, reply) => {
    const { learnerExtKey } = request.query;

    try {
      const [learner] = await db
        .select({ id: schema.learners.id })
        .from(schema.learners)
        .where(eq(schema.learners.extKey, learnerExtKey))
        .limit(1);
      if (!learner) return reply.send({ ok: true, data: [] });

      const rows = await db
        .select({
          role: schema.chatMessages.role,
          text: schema.chatMessages.text,
          createdAt: schema.chatMessages.createdAt,
        })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.learnerId, learner.id))
        .orderBy(asc(schema.chatMessages.createdAt));

      return reply.send({ ok: true, data: rows });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

const pageImageQuery = z.object({
  // Crop box as fractions (0-1) of the full page image — the model's
  // imageRegion, forwarded verbatim by the frontend. All four or none.
  x: z.coerce.number().min(0).max(1).optional(),
  y: z.coerce.number().min(0).max(1).optional(),
  w: z.coerce.number().min(0).max(1).optional(),
  h: z.coerce.number().min(0).max(1).optional(),
});

/**
 * Serve a rasterized page image by its imageKey (e.g. "ckd/page-0001.png"),
 * the same relative path stored in `pages.imageKey` under PAGE_IMAGE_DIR — the
 * "corresponding image" shown alongside a teaching answer. Resolves and
 * checks the path stays inside PAGE_IMAGE_DIR before reading (no traversal
 * outside the image root, even though imageKey values come from our own DB).
 *
 * Optional ?x=&y=&w=&h= (fractions 0-1) crop to just the relevant region of
 * the page the model identified, instead of showing the whole page.
 */
app.get(
  "/api/pages/*",
  {
    schema: {
      tags: ["pages"],
      summary: "Serve a rasterized page image by its imageKey, optionally cropped",
      querystring: pageImageQuery,
    },
  },
  async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];
    if (!wildcard) {
      return reply.code(400).send({ ok: false, error: "missing image path" });
    }

    const root = path.resolve(config.PAGE_IMAGE_DIR);
    const resolved = path.resolve(root, wildcard);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return reply.code(400).send({ ok: false, error: "invalid image path" });
    }

    const crop = request.query;

    try {
      const buf = await readFile(resolved);

      if (
        crop.x !== undefined &&
        crop.y !== undefined &&
        crop.w !== undefined &&
        crop.h !== undefined &&
        crop.w > 0 &&
        crop.h > 0
      ) {
        const image = sharp(buf);
        const { width, height } = await image.metadata();
        if (width && height) {
          const left = Math.min(width - 1, Math.round(crop.x * width));
          const top = Math.min(height - 1, Math.round(crop.y * height));
          const cropWidth = Math.max(1, Math.min(width - left, Math.round(crop.w * width)));
          const cropHeight = Math.max(1, Math.min(height - top, Math.round(crop.h * height)));
          const cropped = await image
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .png()
            .toBuffer();
          return reply.type("image/png").send(cropped);
        }
      }

      return reply.type("image/png").send(buf);
    } catch {
      return reply.code(404).send({ ok: false, error: "image not found" });
    }
  },
);

const assessAskBody = z.object({
  topic: z.string().min(1),
  sourceKey: z.string().optional(),
  drafts: z.boolean().optional(),
  /** How many distinct quiz questions to generate. Defaults to a real quiz, not one question. */
  count: z.number().int().min(1).max(20).optional(),
});

app.post(
  "/api/assess/ask",
  {
    schema: {
      tags: ["assess"],
      summary: "Mode 4 — Assess: generate a batch of quiz questions",
      body: assessAskBody,
    },
  },
  async (request, reply) => {
    const { topic, sourceKey, drafts, count } = request.body;

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
  },
);

const assessGradeBody = z.object({
  itemKey: z.string().min(1),
  learnerExtKey: z.string().min(1),
  response: z.string().min(1),
});

app.post(
  "/api/assess/grade",
  {
    schema: {
      tags: ["assess"],
      summary: "Grade a single quiz response",
      body: assessGradeBody,
    },
  },
  async (request, reply) => {
    const { itemKey, learnerExtKey, response } = request.body;

    try {
      const grade = await assessGrade(itemKey, learnerExtKey, response);
      return reply.send({ ok: true, data: grade });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

const assessGradeBatchBody = z.object({
  learnerExtKey: z.string().min(1),
  responses: z
    .array(z.object({ itemKey: z.string().min(1), response: z.string().min(1) }))
    .min(1),
});

app.post(
  "/api/assess/grade-batch",
  {
    schema: {
      tags: ["assess"],
      summary: "Grade a full exam's worth of answers at once — the \"answer all, then reveal\" flow",
      body: assessGradeBatchBody,
    },
  },
  async (request, reply) => {
    const { learnerExtKey, responses } = request.body;

    try {
      const grades = await assessGradeBatch(learnerExtKey, responses);
      return reply.send({ ok: true, data: grades });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

const gradeResultSchema = z.object({
  itemKey: z.string(),
  objKey: z.string(),
  objStatement: z.string(),
  objectiveId: z.string(),
  stem: z.string(),
  vector: z.string(),
  score: z.number(),
  anchorLabel: z.string(),
  evidence: z.string(),
  errorType: z.string(),
  misconception: z.string().optional(),
  graderConfidence: z.string(),
  facultyFlag: z.boolean(),
  mastery: z.object({ head: z.number(), heart: z.number(), hands: z.number() }),
  correctAnswerKey: z.string().nullable(),
});

const assessFeedbackBody = z.object({
  learnerExtKey: z.string().min(1),
  grades: z.array(gradeResultSchema).min(1),
});

/**
 * MODE 5: FEEDBACK — the frontend calls this right after grade-batch comes
 * back, forwarding those same grades verbatim (§7 Mode 4 -> auto-offer Mode 5).
 * Kept as its own call rather than folded into grade-batch so the per-question
 * reveal isn't held up waiting on it.
 */
app.post(
  "/api/assess/feedback",
  {
    schema: {
      tags: ["assess"],
      summary: "Mode 5 — Feedback: generate feedback from a batch of grades",
      body: assessFeedbackBody,
    },
  },
  async (request, reply) => {
    const { learnerExtKey, grades } = request.body;

    try {
      const feedback = await generateFeedback(learnerExtKey, grades);
      return reply.send({ ok: true, data: feedback });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

const curriculumBody = z.object({
  learnerExtKey: z.string().min(1),
  sourceKey: z.string().optional(),
});

/**
 * MODE 2: CURRICULUM — stateless, reasons fresh over current learner state
 * each call. dueForReview/coverageGaps are deterministic (computed from data
 * Modes 3/4/5 already write); entryPoint/sequence are the one part needing an
 * LLM judgment call, since no prerequisite graph exists in this schema.
 */
app.post(
  "/api/curriculum",
  {
    schema: {
      tags: ["curriculum"],
      summary: "Mode 2 — Curriculum: due-for-review + coverage gaps + suggested sequence",
      body: curriculumBody,
    },
  },
  async (request, reply) => {
    const { learnerExtKey, sourceKey } = request.body;

    try {
      const plan = await generateCurriculum(learnerExtKey, sourceKey ? { sourceKey } : {});
      return reply.send({ ok: true, data: plan });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

async function shutdown(): Promise<void> {
  await app.close();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
