import { timingSafeEqual } from "node:crypto";
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
import { classifyIntent, FALLBACK_TEXT } from "./modes/router.js";
import { endSimulation, startSimulation, takeTurn } from "./modes/simulate.js";
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

/**
 * Shared-secret gate (see config.ts) — every /api/* request must present the
 * secret as `Authorization: Bearer <secret>`, proving the caller is Vaidix's
 * own server (already ran its real login check) and not an arbitrary client
 * supplying any learnerExtKey it likes. /health and /docs stay open.
 *
 * Left UNENFORCED when RAG_BACKEND_SECRET isn't set, so local dev against the
 * standalone frontend keeps working — that frontend runs in the browser, so
 * it can never safely hold this secret itself. The real fix is routing
 * requests through a trusted Vaidix server route, not giving the browser the
 * secret. See memory: vaidix-auth-integration-design.
 */
if (config.RAG_BACKEND_SECRET) {
  const secretBuf = Buffer.from(config.RAG_BACKEND_SECRET);
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;

    const header = request.headers.authorization ?? "";
    const presented = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? null;
    const presentedBuf = presented !== null ? Buffer.from(presented) : null;
    const valid =
      presentedBuf !== null &&
      presentedBuf.length === secretBuf.length &&
      timingSafeEqual(presentedBuf, secretBuf);

    if (!valid) {
      return reply.code(401).send({ ok: false, error: "missing or invalid bearer token" });
    }
  });
} else {
  app.log.warn(
    "RAG_BACKEND_SECRET is not set — /api/* routes are UNAUTHENTICATED. Fine for local dev, unsafe for anything reachable by anyone else.",
  );
}

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

const simulateStartBody = z.object({
  learnerExtKey: z.string().min(1),
  topic: z.string().min(1),
  sourceKey: z.string().optional(),
  drafts: z.boolean().optional(),
});

/** MODE 6: SIMULATE — start a new case; returns only the opening in-character turn. */
app.post(
  "/api/simulate/start",
  {
    schema: {
      tags: ["simulate"],
      summary: "Mode 6 — Simulate: start a new case simulation",
      body: simulateStartBody,
    },
  },
  async (request, reply) => {
    const { learnerExtKey, topic, sourceKey, drafts } = request.body;

    try {
      const result = await startSimulation(learnerExtKey, topic, {
        reviewedOnly: !drafts,
        ...(sourceKey ? { sourceKey } : {}),
      });
      return reply.send({ ok: true, data: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

const simulateTurnBody = z.object({
  simulationId: z.string().min(1),
  learnerExtKey: z.string().min(1),
  action: z.string().min(1),
});

/**
 * Advance a simulation one exchange. On natural case resolution the response
 * includes an inline debrief (Mode 4 score + Mode 5 feedback) — the spec's
 * "auto-transition" — so the caller doesn't need a second round trip.
 */
app.post(
  "/api/simulate/turn",
  {
    schema: {
      tags: ["simulate"],
      summary: "Mode 6 — Simulate: advance a case one turn",
      body: simulateTurnBody,
    },
  },
  async (request, reply) => {
    const { simulationId, learnerExtKey, action } = request.body;

    try {
      const result = await takeTurn(simulationId, learnerExtKey, action);
      return reply.send({ ok: true, data: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

const simulateEndBody = z.object({
  simulationId: z.string().min(1),
  learnerExtKey: z.string().min(1),
});

/** Learner-initiated stop — same debrief path as natural case resolution. */
app.post(
  "/api/simulate/end",
  {
    schema: {
      tags: ["simulate"],
      summary: "Mode 6 — Simulate: end a case early and get the debrief",
      body: simulateEndBody,
    },
  },
  async (request, reply) => {
    const { simulationId, learnerExtKey } = request.body;

    try {
      const result = await endSimulation(simulationId, learnerExtKey);
      return reply.send({ ok: true, data: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  },
);

const chatBody = z.object({
  learnerExtKey: z.string().min(1),
  message: z.string().min(1),
  sourceKey: z.string().optional(),
  drafts: z.boolean().optional(),
});

/**
 * MODE 0: SESSION ORCHESTRATION — classifies a free-text message and
 * dispatches to the mode it belongs to (§6.1). Only covers fresh, single-turn
 * requests; see modes/router.ts for why grading/feedback stay off this path.
 */
app.post(
  "/api/chat",
  {
    schema: {
      tags: ["chat"],
      summary: "Mode 0 — Router: classify a message and dispatch to the right mode",
      body: chatBody,
    },
  },
  async (request, reply) => {
    const { learnerExtKey, message, sourceKey, drafts } = request.body;

    try {
      const decision = await classifyIntent(message);
      const topic = decision.topic ?? message;
      const reviewedOnly = !drafts;

      if (decision.confidence !== "high" || decision.mode === "UNCLEAR") {
        return reply.send({ ok: true, data: { mode: "UNCLEAR", result: { message: FALLBACK_TEXT } } });
      }

      switch (decision.mode) {
        case "TEACH": {
          const result = await teach(learnerExtKey, topic, { reviewedOnly, ...(sourceKey ? { sourceKey } : {}) });
          return reply.send({ ok: true, data: { mode: "TEACH", result } });
        }
        case "ASSESS": {
          const result = await assessAskBatch(topic, 5, { reviewedOnly, ...(sourceKey ? { sourceKey } : {}) });
          return reply.send({ ok: true, data: { mode: "ASSESS", result } });
        }
        case "CURRICULUM": {
          const result = await generateCurriculum(learnerExtKey, sourceKey ? { sourceKey } : {});
          return reply.send({ ok: true, data: { mode: "CURRICULUM", result } });
        }
        case "SIMULATE": {
          const result = await startSimulation(learnerExtKey, topic, {
            reviewedOnly,
            ...(sourceKey ? { sourceKey } : {}),
          });
          return reply.send({ ok: true, data: { mode: "SIMULATE", result } });
        }
        case "INGEST": {
          return reply.send({
            ok: true,
            data: {
              mode: "INGEST",
              result: { message: "Content ingestion runs from source documents, not chat — use `npm run ingest`." },
            },
          });
        }
        default:
          return reply.send({ ok: true, data: { mode: "UNCLEAR", result: { message: FALLBACK_TEXT } } });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: errorMessage });
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
