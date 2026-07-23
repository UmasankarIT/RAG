import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, gte, inArray, or } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { colpaliHealthy } from "../embed/colpali.js";
import { generate, type GenerateImage } from "../llm.js";
import { retrieve, retrieveNodesLexical } from "../retrieve/index.js";

/**
 * MODE 3: TEACHING (Priority 1).
 *
 * Retrieve the knowledge nodes for a topic, load the learner's state, and ask
 * the model to teach ONLY from those nodes — citing each claim by its [KN-xx]
 * key (R0.1). Cognitive-load governed: <=2 nodes, one bold safety point, one
 * closing retrieval question. Closes the loop by seeding the spaced-review queue.
 */

/** Cognitive load: at most two knowledge nodes per teaching turn. */
const MAX_NODES = 2;

/** Small talk with no retrievable content — short-circuit before hitting the DB/LLM. */
const GREETING_RE =
  /^(?:h+i+|h+e+y+|h+e+l+o+|yo+|sup|howdy|good\s*(?:morning|afternoon|evening)|thanks?(?:\s*you)?|thank\s*you|ok(?:ay)?|bye|goodbye|see\s*ya)[!.,\s]*$/i;

const GREETING_REPLY =
  "Hi! Ask me about a topic from the ingested material — a finding, mechanism, or clinical question — and I'll teach it, citing sources as I go.";

function isGreeting(topic: string): boolean {
  return GREETING_RE.test(topic.trim());
}

/**
 * Fallback system prompt for when nothing in the ingested library covers the
 * topic. Answers from the model's general medical knowledge instead of
 * refusing outright — but every such answer must be clearly flagged as
 * ungrounded (TeachResult.grounded = false) so it's never confused with a
 * cited, faculty-reviewed answer.
 */
const GENERAL_SYSTEM = `You are the 3H Pedagogical Agent teaching ophthalmology (Mode 3: TEACH).

Nothing in the ingested, faculty-reviewed source library covers this topic, so you are answering from general medical knowledge instead. This answer will be labeled to the learner as general knowledge, not a cited source — so:
- Open with one short sentence making clear this is general knowledge, not from the reviewed source library, and should be verified against a primary reference.
- Then teach it well: weave HEAD (what to know), HEART (patient impact/communication), and HANDS (clinical workflow) where they fit naturally.
- Cognitive load: at most two core ideas, one bolded genuine clinical safety point (not a disclaimer), under ~300 words.
- Do not invent citations or [KN-xx] tags — there are none for this answer.
- End with exactly ONE genuine retrieval question for the learner.`;

const SYSTEM = `You are the 3H Pedagogical Agent teaching ophthalmology (Mode 3: TEACH).

Teach ONLY from the knowledge nodes provided in the message. Each node is tagged with a 3H vector (HEAD/HEART/HANDS) and an id like KN-14.
- Ground every claim in a provided node and cite it inline with its id in square brackets, e.g. [KN-14]. Never use facts that are not in the provided nodes. If the nodes do not cover part of the topic, say so plainly rather than filling the gap from memory.
- Weave the three H's where the nodes allow: what to know (HEAD), how it affects the patient — comfort, consent, communication (HEART), and how it fits the clinical workflow (HANDS).
- Never state a drug dose, laser setting, or diagnostic threshold that is not written in a node.
- Cognitive load: teach at most two core ideas. Put the single most important safety point in **bold**. Keep it under ~300 words. No preamble.
- If a prior mastered objective is provided, open by briefly linking the new material to it.
- End with exactly ONE retrieval question for the learner (genuine, not rhetorical). Write nothing after the question.`;

interface TeachNode {
  knKey: string;
  vector: string;
  title: string | null;
  content: string;
  imageKey: string | null;
  sourceKey: string;
  sourceTitle: string | null;
}

export interface TeachOptions {
  sourceKey?: string;
  /** Only teach from faculty-reviewed nodes. Defaults to true. */
  reviewedOnly?: boolean;
}

export interface TeachResult {
  learnerExtKey: string;
  topic: string;
  text: string;
  /** [KN-xx] ids in the answer that resolve to a provided node. */
  citations: string[];
  /** [KN-xx] ids the model cited that were NOT provided — a grounding failure. */
  unknownCitations: string[];
  nodesUsed: { knKey: string; vector: string }[];
  usedVisual: boolean;
  /** OBJ-xx keys added to the learner's spaced-review queue. */
  scheduledReview: string[];
  /** False for greetings and the general-knowledge fallback — no cited source backs this answer. */
  grounded: boolean;
  /** True only for the canned greeting reply — distinguishes it from the general-knowledge fallback, which also has grounded=false. */
  smallTalk: boolean;
}

export async function teach(
  learnerExtKey: string,
  topic: string,
  options: TeachOptions = {},
): Promise<TeachResult> {
  if (isGreeting(topic)) {
    return {
      learnerExtKey,
      topic,
      text: GREETING_REPLY,
      citations: [],
      unknownCitations: [],
      nodesUsed: [],
      usedVisual: false,
      scheduledReview: [],
      grounded: false,
      smallTalk: true,
    };
  }

  const reviewedOnly = options.reviewedOnly ?? true;
  const learner = await ensureLearner(learnerExtKey);

  const { nodes, usedVisual } = await gather(topic, { ...options, reviewedOnly });
  if (nodes.length === 0) {
    const text = await generate({
      system: GENERAL_SYSTEM,
      text: `Teach this topic: "${topic}"`,
      maxTokens: 1200,
    });
    return {
      learnerExtKey,
      topic,
      text,
      citations: [],
      unknownCitations: [],
      nodesUsed: [],
      usedVisual: false,
      scheduledReview: [],
      grounded: false,
      smallTalk: false,
    };
  }

  const images = await loadImages(nodes);
  const prior = await priorKnowledge(learner.id);

  const text = await generate({
    system: SYSTEM,
    text: buildPrompt(topic, nodes, learner.level, prior),
    images,
    maxTokens: 1200,
  });

  // Grounding check: every [KN-xx] must be one we actually supplied.
  const provided = new Set(nodes.map((n) => n.knKey));
  const cited = [...new Set((text.match(/\[KN-\d+\]/g) ?? []).map((s) => s.slice(1, -1)))];
  const citations = cited.filter((c) => provided.has(c));
  const unknownCitations = cited.filter((c) => !provided.has(c));

  const scheduledReview = await scheduleReview(
    learner.id,
    nodes.map((n) => n.knKey),
  );

  return {
    learnerExtKey,
    topic,
    text,
    citations,
    unknownCitations,
    nodesUsed: nodes.map((n) => ({ knKey: n.knKey, vector: n.vector })),
    usedVisual,
    scheduledReview,
    grounded: true,
    smallTalk: false,
  };
}

/** Visual two-stage when ColPali is up; lexical full-text otherwise. */
async function gather(
  topic: string,
  opts: { sourceKey?: string; reviewedOnly: boolean },
): Promise<{ nodes: TeachNode[]; usedVisual: boolean }> {
  if (await colpaliHealthy()) {
    const pages = await retrieve(topic, {
      topK: MAX_NODES,
      reviewedOnly: opts.reviewedOnly,
      ...(opts.sourceKey ? { sourceKey: opts.sourceKey } : {}),
    });
    const nodes: TeachNode[] = [];
    for (const pg of pages) {
      for (const n of pg.nodes) {
        nodes.push({
          knKey: n.knKey,
          vector: n.vector,
          title: n.title,
          content: n.content,
          imageKey: pg.imageKey,
          sourceKey: pg.sourceKey,
          sourceTitle: pg.sourceTitle,
        });
        if (nodes.length >= MAX_NODES) return { nodes, usedVisual: true };
      }
    }
    if (nodes.length > 0) return { nodes, usedVisual: true };
  }

  const lex = await retrieveNodesLexical(topic, {
    limit: MAX_NODES,
    reviewedOnly: opts.reviewedOnly,
    ...(opts.sourceKey ? { sourceKey: opts.sourceKey } : {}),
  });
  return {
    nodes: lex.map((n) => ({
      knKey: n.knKey,
      vector: n.vector,
      title: n.title,
      content: n.content,
      imageKey: n.imageKey,
      sourceKey: n.sourceKey,
      sourceTitle: n.sourceTitle,
    })),
    usedVisual: false,
  };
}

async function ensureLearner(extKey: string) {
  const [existing] = await db
    .select()
    .from(schema.learners)
    .where(eq(schema.learners.extKey, extKey))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(schema.learners)
    .values({ extKey })
    .returning();
  return created!;
}

/** Load each node's page image once (dual coding), deduped by image. */
async function loadImages(nodes: TeachNode[]): Promise<GenerateImage[]> {
  const seen = new Set<string>();
  const images: GenerateImage[] = [];
  for (const n of nodes) {
    if (!n.imageKey || seen.has(n.imageKey)) continue;
    seen.add(n.imageKey);
    try {
      const buf = await readFile(path.join(config.PAGE_IMAGE_DIR, n.imageKey));
      images.push({ base64: buf.toString("base64"), label: `--- ${n.sourceTitle ?? n.sourceKey} ---` });
    } catch {
      // image missing on disk — teach from text alone
    }
  }
  return images;
}

/** Up to three objectives the learner has already mastered, to activate prior knowledge. */
async function priorKnowledge(learnerId: string): Promise<string> {
  const rows = await db
    .select({ objKey: schema.objectives.objKey, statement: schema.objectives.statement })
    .from(schema.mastery)
    .innerJoin(schema.objectives, eq(schema.objectives.id, schema.mastery.objectiveId))
    .where(
      and(
        eq(schema.mastery.learnerId, learnerId),
        or(gte(schema.mastery.head, 3), gte(schema.mastery.heart, 3), gte(schema.mastery.hands, 3)),
      ),
    )
    .limit(3);
  if (rows.length === 0) return "";
  return rows.map((r) => `${r.objKey}: ${r.statement}`).join("; ");
}

function buildPrompt(
  topic: string,
  nodes: TeachNode[],
  level: string,
  prior: string,
): string {
  const nodeText = nodes
    .map((n) => `[${n.knKey} | ${n.vector}]${n.title ? ` ${n.title}` : ""}\n${n.content}`)
    .join("\n\n");
  const priorLine = prior
    ? `The learner has already mastered: ${prior}. Link the new material to this where natural.`
    : `This is a new learner with no recorded mastery yet.`;
  return `Learner level: ${level}.
${priorLine}

Teach this topic: "${topic}"

Use ONLY these knowledge nodes (page images are attached for dual coding):

${nodeText}`;
}

/** Seed the spaced-review queue with the objectives the taught nodes advance. */
async function scheduleReview(learnerId: string, knKeys: string[]): Promise<string[]> {
  const rows = await db
    .selectDistinct({
      objectiveId: schema.nodeObjectives.objectiveId,
      objKey: schema.objectives.objKey,
    })
    .from(schema.nodeObjectives)
    .innerJoin(schema.knowledgeNodes, eq(schema.knowledgeNodes.id, schema.nodeObjectives.nodeId))
    .innerJoin(schema.objectives, eq(schema.objectives.id, schema.nodeObjectives.objectiveId))
    .where(inArray(schema.knowledgeNodes.knKey, knKeys));

  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // review in 1 day
  for (const row of rows) {
    await db
      .insert(schema.reviewQueue)
      .values({ learnerId, objectiveId: row.objectiveId, dueAt, intervalDays: 1 })
      .onConflictDoUpdate({
        target: [schema.reviewQueue.learnerId, schema.reviewQueue.objectiveId],
        set: { dueAt, intervalDays: 1 },
      });
  }
  return rows.map((r) => r.objKey);
}
