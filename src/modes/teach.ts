import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { colpaliHealthy } from "../embed/colpali.js";
import { generate, structureFromImage } from "../llm.js";
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

/**
 * Structured teaching turn (grounded path): a short summary, a caption for the
 * one page image shown to the learner, the 3H breakdown, and a closing
 * question — returned as discrete fields (not free-form markdown) so the UI
 * can lay them out: summary -> image -> caption -> HEAD/HEART/HANDS -> question.
 */
const TEACH_SYSTEM = `You are the 3H Pedagogical Agent teaching ophthalmology (Mode 3: TEACH).

Teach ONLY from the knowledge nodes provided in the message. Each node is tagged with a 3H vector (HEAD/HEART/HANDS) and an id like KN-14. If one page image is attached, it is the source page for these nodes — but the source page is not always a genuinely illustrative image (it may be body text, a title page, or a figure about something else on the same page).
- Ground every claim in a provided node and cite it inline with its id in square brackets, e.g. [KN-14]. Never use facts that are not in the provided nodes. If the nodes do not cover part of the topic, say so plainly rather than filling the gap from memory.
- summary: answer the learner's question directly in 6-7 lines, citing nodes.
- imageRelevant: true ONLY if the attached image contains a genuine CLINICAL/VISUAL figure relevant to this topic — a clinical photograph, fundus/OCT/imaging scan, histology image, surgical photo, or an anatomical/mechanism diagram. This is strict: false for statistical charts, bar/line graphs, forest plots, data tables, flowcharts of study methodology, or any figure that is fundamentally text/numbers/data rendered as an image rather than a picture of a real or illustrated clinical subject. Also false if it's unrelated to this topic, is plain body text, or is a title/reference page. If no image was attached, set this to false. When in doubt between a clinical image and a data figure, choose false.
- imageRegion: ONLY when imageRelevant is true AND the clinical image is a distinct sub-area of the page (sitting among body text or other figures) rather than the whole page — give its bounding box as fractions of the full page image's width/height (0 to 1, left-to-right, top-to-bottom): {x, y, width, height}. Omit this field entirely if the image fills the whole page or you cannot localize it confidently — the full page will be shown instead.
- imageCaption: 1-2 sentences describing what the image (or cropped region) shows and how it illustrates the answer. Include this ONLY if imageRelevant is true — omit it otherwise.
- head: the cognitive content — facts, mechanisms, classifications — citing nodes.
- heart: the patient-facing content — comfort, consent, communication. If the nodes don't cover this angle, say so plainly rather than inventing it.
- hands: the clinical-workflow content — procedure, sequencing, what to do. If the nodes don't cover this angle, say so plainly rather than inventing it.
- Never state a drug dose, laser setting, or diagnostic threshold that is not written in a node.
- Cognitive load: at most two core ideas total across the fields. Put the single most important genuine clinical safety point in **bold**, inside whichever field it belongs to — never fabricate one if there isn't a real one.
- If a prior mastered objective is provided, open the summary by briefly linking the new material to it.
- If a prior learner error/misconception is provided and today's material touches on it, proactively and explicitly correct that misconception as part of the answer — don't wait to be asked, and don't just silently avoid restating the error.
- question: exactly ONE genuine retrieval question for the learner about what was just taught (not rhetorical).
- suggestedQuestions: 2-3 natural follow-up questions that go deeper on THIS SAME topic (not a topic switch) — the kind a curious learner would ask next. Only propose ones answerable from the provided nodes or a very close extension of them.`;

const TEACH_SCHEMA_NAME = "emit_teaching_turn";
const TEACH_SCHEMA_DESCRIPTION =
  "Emit one structured teaching turn: summary, image region/caption, 3H breakdown, a closing retrieval question, and follow-up question suggestions.";

const TEACH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string", description: "6-7 line direct answer, citing [KN-xx]." },
    imageRelevant: {
      type: "boolean",
      description:
        "True only for a genuine clinical/visual image (photo, scan, histology, anatomical diagram) relevant to this topic. False for charts, graphs, tables, or any data-as-image content — those are never shown, even if technically 'a figure'.",
    },
    imageRegion: {
      type: "object",
      description:
        "Bounding box (fractions 0-1 of the page image) of the specific clinical image, if it's only part of the page. Omit if the whole page is the image or the region can't be localized confidently.",
      properties: {
        x: { type: "number", description: "Left edge, 0-1 fraction of image width." },
        y: { type: "number", description: "Top edge, 0-1 fraction of image height." },
        width: { type: "number", description: "Width, 0-1 fraction of image width." },
        height: { type: "number", description: "Height, 0-1 fraction of image height." },
      },
      required: ["x", "y", "width", "height"],
    },
    imageCaption: {
      type: "string",
      description: "1-2 sentences on what the image (or cropped region) shows. Include only if imageRelevant is true.",
    },
    head: { type: "string", description: "Cognitive content: facts, mechanisms, classifications." },
    heart: { type: "string", description: "Patient-facing content: comfort, consent, communication." },
    hands: { type: "string", description: "Clinical-workflow content: procedure, sequencing." },
    question: { type: "string", description: "Exactly one genuine retrieval question for the learner." },
    suggestedQuestions: {
      type: "array",
      description: "2-3 natural follow-up questions that go deeper on this same topic.",
      items: { type: "string" },
    },
  },
  required: ["summary", "imageRelevant", "head", "heart", "hands", "question", "suggestedQuestions"],
};

const zImageRegion = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

/** Max words for the teaching-chunk explanation (§5 Cognitive Load Governor: "teaching chunk ≤ 350 words + 1 question"). */
const MAX_EXPLANATION_WORDS = 350;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const zTeachSections = z
  .object({
    summary: z.string().min(1),
    imageRelevant: z.boolean(),
    imageRegion: zImageRegion.optional(),
    imageCaption: z.string().optional(),
    head: z.string().min(1),
    heart: z.string().min(1),
    hands: z.string().min(1),
    question: z.string().min(1),
    suggestedQuestions: z.array(z.string()).default([]),
  })
  .superRefine((data, ctx) => {
    // The explanation is summary+head+heart+hands combined — question and
    // suggestedQuestions are separately governed, not part of this budget.
    const total =
      wordCount(data.summary) + wordCount(data.head) + wordCount(data.heart) + wordCount(data.hands);
    if (total > MAX_EXPLANATION_WORDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `explanation (summary+head+heart+hands) is ${total} words — must be ≤${MAX_EXPLANATION_WORDS}. Tighten it.`,
      });
    }
  });

export type TeachSections = z.infer<typeof zTeachSections>;

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
  nodesUsed: { knKey: string; vector: string; title: string | null; sourceTitle: string | null }[];
  usedVisual: boolean;
  /** OBJ-xx keys added to the learner's spaced-review queue. */
  scheduledReview: string[];
  /** False for greetings and the general-knowledge fallback — no cited source backs this answer. */
  grounded: boolean;
  /** True only for the canned greeting reply — distinguishes it from the general-knowledge fallback, which also has grounded=false. */
  smallTalk: boolean;
  /** Structured summary/image-caption/3H/question breakdown — present only for grounded answers. */
  sections?: TeachSections;
  /** Relative path under PAGE_IMAGE_DIR for the primary node's page image (served via GET /api/pages/:imageKey), if any. */
  imageKey?: string | null;
}

export async function teach(
  learnerExtKey: string,
  topic: string,
  options: TeachOptions = {},
): Promise<TeachResult> {
  const learner = await ensureLearner(learnerExtKey);

  if (isGreeting(topic)) {
    await logChat(learner.id, topic, GREETING_REPLY);
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

  const { nodes, usedVisual } = await gather(topic, { ...options, reviewedOnly });
  if (nodes.length === 0) {
    const text = await generate({
      system: GENERAL_SYSTEM,
      text: `Teach this topic: "${topic}"`,
      maxTokens: 1200,
    });
    await logChat(learner.id, topic, text);
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

  const prior = await priorKnowledge(learner.id);
  const priorMistakes = await priorErrors(
    learner.id,
    nodes.map((n) => n.knKey),
  );
  const primaryImage = await loadPrimaryImage(nodes);

  const sections = await structureFromImage<TeachSections>({
    system: TEACH_SYSTEM,
    text: buildPrompt(topic, nodes, learner.level, prior, priorMistakes),
    ...(primaryImage ? { imageBase64: primaryImage.base64 } : {}),
    schemaName: TEACH_SCHEMA_NAME,
    schemaDescription: TEACH_SCHEMA_DESCRIPTION,
    schema: TEACH_INPUT_SCHEMA,
    validate: (input) => zTeachSections.parse(input),
    maxTokens: 1800,
  });

  // Flat fallback for the CLI and the citation scan below. Matches the id
  // anywhere — not just single-id brackets [KN-14] — because the model
  // sometimes groups several into one bracket, e.g. [KN-39, KN-9].
  const text = [sections.summary, sections.head, sections.heart, sections.hands, sections.question]
    .join("\n\n");
  const provided = new Set(nodes.map((n) => n.knKey));
  const cited = [...new Set(text.match(/KN-\d+/g) ?? [])];
  const citations = cited.filter((c) => provided.has(c));
  const unknownCitations = cited.filter((c) => !provided.has(c));

  const scheduledReview = await scheduleReview(
    learner.id,
    nodes.map((n) => n.knKey),
  );

  await logChat(learner.id, topic, text);

  return {
    learnerExtKey,
    topic,
    text,
    citations,
    unknownCitations,
    sections,
    // Only surface the image to the learner if the model judged it genuinely
    // illustrative — never just because a page image happened to exist.
    imageKey: sections.imageRelevant ? (primaryImage?.imageKey ?? null) : null,
    nodesUsed: nodes.map((n) => ({
      knKey: n.knKey,
      vector: n.vector,
      title: n.title,
      sourceTitle: n.sourceTitle,
    })),
    usedVisual,
    scheduledReview,
    grounded: true,
    smallTalk: false,
  };
}

/**
 * Widen retrieval past MAX_NODES so there's a real pool to pick a diverse set
 * from — pure top-K-by-relevance tends to return the same vector (usually
 * HEAD) repeatedly for dense source text, starving HEART/HANDS of any node
 * to draw from even when the corpus has one.
 */
const CANDIDATE_POOL = MAX_NODES * 4;

/**
 * Prefer covering distinct 3H vectors within the MAX_NODES budget instead of
 * blindly taking the top-ranked nodes regardless of vector. First pass picks
 * the best-ranked node per not-yet-seen vector (in relevance order); second
 * pass fills any remaining slots with the next-best remaining candidates.
 * Does not guarantee all three vectors are present — MAX_NODES may be less
 * than the number of vectors, or the corpus may simply lack one for this
 * topic — but stops the common failure mode of 2 same-vector nodes crowding
 * out material that does exist.
 */
function selectDiverse(nodes: TeachNode[], max: number): TeachNode[] {
  const picked: TeachNode[] = [];
  const usedVectors = new Set<string>();
  for (const n of nodes) {
    if (picked.length >= max) break;
    if (!usedVectors.has(n.vector)) {
      picked.push(n);
      usedVectors.add(n.vector);
    }
  }
  for (const n of nodes) {
    if (picked.length >= max) break;
    if (!picked.includes(n)) picked.push(n);
  }
  return picked;
}

/** Visual two-stage when ColPali is up; lexical full-text otherwise. */
async function gather(
  topic: string,
  opts: { sourceKey?: string; reviewedOnly: boolean },
): Promise<{ nodes: TeachNode[]; usedVisual: boolean }> {
  if (await colpaliHealthy()) {
    const pages = await retrieve(topic, {
      topK: CANDIDATE_POOL,
      reviewedOnly: opts.reviewedOnly,
      ...(opts.sourceKey ? { sourceKey: opts.sourceKey } : {}),
    });
    const candidates: TeachNode[] = [];
    for (const pg of pages) {
      for (const n of pg.nodes) {
        candidates.push({
          knKey: n.knKey,
          vector: n.vector,
          title: n.title,
          content: n.content,
          imageKey: pg.imageKey,
          sourceKey: pg.sourceKey,
          sourceTitle: pg.sourceTitle,
        });
      }
    }
    if (candidates.length > 0) return { nodes: selectDiverse(candidates, MAX_NODES), usedVisual: true };
  }

  const lex = await retrieveNodesLexical(topic, {
    limit: CANDIDATE_POOL,
    reviewedOnly: opts.reviewedOnly,
    ...(opts.sourceKey ? { sourceKey: opts.sourceKey } : {}),
  });
  const candidates: TeachNode[] = lex.map((n) => ({
    knKey: n.knKey,
    vector: n.vector,
    title: n.title,
    content: n.content,
    imageKey: n.imageKey,
    sourceKey: n.sourceKey,
    sourceTitle: n.sourceTitle,
  }));
  return { nodes: selectDiverse(candidates, MAX_NODES), usedVisual: false };
}

/** Persist one conversational turn (§4 session_history) — the raw text the learner actually saw. */
async function logChat(learnerId: string, topic: string, answerText: string): Promise<void> {
  await db.insert(schema.chatMessages).values([
    { learnerId, role: "user", text: topic },
    { learnerId, role: "bot", text: answerText },
  ]);
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

/**
 * Load the page image for the single most relevant node — the "corresponding
 * image" shown to the learner alongside the answer. Only one goes to the
 * model (structureFromImage takes a single image) and only one is shown in
 * the UI, so we don't bother deduping across nodes here.
 */
async function loadPrimaryImage(
  nodes: TeachNode[],
): Promise<{ base64: string; imageKey: string } | null> {
  const withImage = nodes.find((n) => n.imageKey);
  if (!withImage?.imageKey) return null;
  try {
    const buf = await readFile(path.join(config.PAGE_IMAGE_DIR, withImage.imageKey));
    return { base64: buf.toString("base64"), imageKey: withImage.imageKey };
  } catch {
    return null; // image missing on disk — teach from text alone
  }
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
  priorMistakes: string,
): string {
  const nodeText = nodes
    .map((n) => `[${n.knKey} | ${n.vector}]${n.title ? ` ${n.title}` : ""}\n${n.content}`)
    .join("\n\n");
  const priorLine = prior
    ? `The learner has already mastered: ${prior}. Link the new material to this where natural.`
    : `This is a new learner with no recorded mastery yet.`;
  const mistakesLine = priorMistakes
    ? `\nThis learner has previously shown these errors on related material: ${priorMistakes}. If today's material touches on this, proactively and explicitly correct the misconception.`
    : "";
  return `Learner level: ${level}.
${priorLine}${mistakesLine}

Teach this topic: "${topic}"

Use ONLY these knowledge nodes (the source page image is attached, if available):

${nodeText}`;
}

/**
 * Up to three prior errors this learner has shown on objectives THIS topic's
 * nodes teach toward — the read side of §4 misconception tracking. `assess.ts`
 * already writes error_log on every diagnosed grading error; this is what was
 * missing — Teach never looked at it. Ranked by recurrence: a misconception
 * seen more than once is the one most worth proactively correcting.
 */
async function priorErrors(learnerId: string, knKeys: string[]): Promise<string> {
  if (knKeys.length === 0) return "";

  const rows = await db
    .selectDistinct({
      objKey: schema.objectives.objKey,
      errorType: schema.errorLog.errorType,
      misconception: schema.errorLog.misconception,
      description: schema.errorLog.description,
      recurrence: schema.errorLog.recurrence,
    })
    .from(schema.errorLog)
    .innerJoin(schema.objectives, eq(schema.objectives.id, schema.errorLog.objectiveId))
    .innerJoin(schema.nodeObjectives, eq(schema.nodeObjectives.objectiveId, schema.objectives.id))
    .innerJoin(schema.knowledgeNodes, eq(schema.knowledgeNodes.id, schema.nodeObjectives.nodeId))
    .where(and(eq(schema.errorLog.learnerId, learnerId), inArray(schema.knowledgeNodes.knKey, knKeys)))
    .orderBy(desc(schema.errorLog.recurrence))
    .limit(3);

  if (rows.length === 0) return "";
  return rows
    .map(
      (r) =>
        `${r.objKey} [${r.errorType}${r.recurrence > 1 ? `, seen ${r.recurrence}x` : ""}]: ${r.misconception ?? r.description ?? "unspecified"}`,
    )
    .join("; ");
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
