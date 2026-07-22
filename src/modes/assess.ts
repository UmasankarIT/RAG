import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { structureFromImage } from "../llm.js";
import { retrieveNodesLexical } from "../retrieve/index.js";

/**
 * MODE 4: ASSESSMENT (Priority 2) — the keystone that writes mastery.
 *
 *   ask   → generate one gradeable item for a topic, grounded in KN-nodes,
 *           distractors drawn from the misconception bank, mapped to an OBJ.
 *   grade → score the learner's answer against the §8 anchored rubric for the
 *           item's vector, write mastery (that vector only — never averaged),
 *           log the error, and flag low-confidence grading for faculty (§10).
 */

// --- §8 anchored rubrics (verbatim; R0.6) ----------------------------------

const RUBRICS: Record<string, string> = {
  HEAD: `HEAD — SOLO Taxonomy (0-4):
0 Prestructural: irrelevant/incorrect; misses the point
1 Unistructural: one relevant fact, no connections
2 Multistructural: several correct facts, listed but unlinked
3 Relational: facts integrated into causal/diagnostic reasoning
4 Extended Abstract: generalizes to novel cases; anticipates exceptions`,
  HANDS: `HANDS — Miller x Dave (0-4):
0 Cannot state steps
1 Knows: states steps and parameters correctly
2 Knows How: sequences steps for a specific case; adapts parameters
3 Shows How: detects own errors, executes recovery, verbalizes safety checks
4 Does*: DO NOT AWARD from text — requires workplace-based assessment. Cap text grading at 3.`,
  HEART: `HEART — Behaviorally Anchored Rating Scale (0-4):
0 Patient absent from response; safety/consent ignored
1 Token empathy phrase; no behavioral integration
2 Acknowledges patient emotion/consent but does not alter the plan
3 Modifies communication or plan based on patient perspective, comfort, consent
4 Anticipates unspoken concerns; integrates ethics, equity, shared decision-making`,
};

// --- item generation -------------------------------------------------------

const GEN_SYSTEM = `You are the examiner of a 3H ophthalmology education platform (Mode 4: ASSESS).

Write ONE single-best-answer MCQ that tests the given learning objective, grounded ONLY in the provided knowledge nodes. Rules:
- Exactly 4 options; exactly one correct.
- Build wrong options ("distractors") from the provided misconceptions where possible — plausible but wrong for a real reason.
- Never write a drug dose, laser setting, or threshold that is not in a node.
- For each option give a one-line rationale (why correct / why the distractor is tempting but wrong).
- The stem must be answerable from the nodes alone.`;

const genSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    stem: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    answerIndex: { type: "integer", description: "0-based index of the correct option" },
    rationale: { type: "array", items: { type: "string" }, description: "one per option, same order" },
  },
  required: ["stem", "options", "answerIndex", "rationale"],
};

const zGen = z.object({
  stem: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  answerIndex: z.number().int().min(0).max(3),
  rationale: z.array(z.string()).min(1),
});

export interface AskOptions {
  sourceKey?: string;
  reviewedOnly?: boolean;
}

export interface AskResult {
  itemKey: string;
  objKey: string;
  vector: string;
  taxonomyLevel: string | null;
  stem: string;
  options: string[];
}

export async function assessAsk(
  topic: string,
  options: AskOptions = {},
): Promise<AskResult> {
  const reviewedOnly = options.reviewedOnly ?? true;

  const nodes = await retrieveNodesLexical(topic, {
    limit: 3,
    reviewedOnly,
    ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
  });
  if (nodes.length === 0) {
    throw new Error(`no ${reviewedOnly ? "reviewed " : ""}knowledge nodes found for "${topic}"`);
  }
  const knKeys = nodes.map((n) => n.knKey);

  // Target objective: the first objective these nodes teach toward.
  const [target] = await db
    .selectDistinct({
      objectiveId: schema.objectives.id,
      objKey: schema.objectives.objKey,
      vector: schema.objectives.vector,
      taxonomyLevel: schema.objectives.taxonomyLevel,
      statement: schema.objectives.statement,
    })
    .from(schema.nodeObjectives)
    .innerJoin(schema.knowledgeNodes, eq(schema.knowledgeNodes.id, schema.nodeObjectives.nodeId))
    .innerJoin(schema.objectives, eq(schema.objectives.id, schema.nodeObjectives.objectiveId))
    .where(inArray(schema.knowledgeNodes.knKey, knKeys))
    .limit(1);

  if (!target) throw new Error(`no objective is linked to the nodes for "${topic}"`);

  const misc = await db
    .select({ description: schema.misconceptions.description })
    .from(schema.misconceptions)
    .innerJoin(schema.knowledgeNodes, eq(schema.knowledgeNodes.id, schema.misconceptions.nodeId))
    .where(inArray(schema.knowledgeNodes.knKey, knKeys));

  const gen = await structureFromImage<z.infer<typeof zGen>>({
    system: GEN_SYSTEM,
    text: buildGenPrompt(target, nodes, misc.map((m) => m.description)),
    schemaName: "emit_mcq",
    schemaDescription: "Emit one single-best-answer MCQ grounded in the nodes.",
    schema: genSchema,
    validate: (i) => zGen.parse(i),
    maxTokens: 2048,
  });

  const answerKey = String.fromCharCode(65 + gen.answerIndex); // A..D

  const [row] = await db
    .insert(schema.assessmentItems)
    .values({
      itemKey: randomUUID(), // temp unique placeholder; set to ITEM-<seq> below
      objectiveId: target.objectiveId,
      vector: target.vector,
      taxonomyLevel: target.taxonomyLevel,
      itemType: "MCQ",
      stem: gen.stem,
      options: gen.options,
      answerKey,
      rationale: gen.rationale,
      citedKnKeys: knKeys,
    })
    .returning({ id: schema.assessmentItems.id, seq: schema.assessmentItems.seq });

  const itemKey = `ITEM-${row!.seq}`;
  await db
    .update(schema.assessmentItems)
    .set({ itemKey })
    .where(eq(schema.assessmentItems.id, row!.id));

  return {
    itemKey,
    objKey: target.objKey,
    vector: target.vector,
    taxonomyLevel: target.taxonomyLevel,
    stem: gen.stem,
    options: gen.options,
  };
}

function buildGenPrompt(
  target: { objKey: string; vector: string; taxonomyLevel: string | null; statement: string },
  nodes: { knKey: string; vector: string; content: string }[],
  misconceptions: string[],
): string {
  const nodeText = nodes.map((n) => `[${n.knKey} | ${n.vector}] ${n.content}`).join("\n");
  const miscText = misconceptions.length
    ? misconceptions.map((m) => `- ${m}`).join("\n")
    : "(none provided)";
  return `Objective ${target.objKey} [${target.vector} | ${target.taxonomyLevel ?? "n/a"}]: ${target.statement}

Knowledge nodes:
${nodeText}

Known misconceptions (use as distractors where they fit):
${miscText}`;
}

// --- grading ---------------------------------------------------------------

const gradeSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    score: { type: "integer", description: "0-4 anchored rubric score" },
    anchorLabel: { type: "string", description: "the rubric level name you assigned" },
    evidence: { type: "string", description: "quote or paraphrase from the learner's response justifying the score" },
    errorType: { type: "string", enum: ["knowledge", "reasoning", "technique", "affect", "none"] },
    misconception: { type: "string", description: "the specific misconception shown, if any" },
    graderConfidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["score", "anchorLabel", "evidence", "errorType", "graderConfidence"],
};

const zGrade = z.object({
  score: z.number().int().min(0).max(4),
  anchorLabel: z.string(),
  evidence: z.string(),
  errorType: z.enum(["knowledge", "reasoning", "technique", "affect", "none"]),
  misconception: z.string().optional(),
  graderConfidence: z.enum(["high", "medium", "low"]),
});

export interface GradeResult {
  itemKey: string;
  objKey: string;
  vector: string;
  score: number;
  anchorLabel: string;
  evidence: string;
  errorType: string;
  misconception?: string;
  graderConfidence: string;
  facultyFlag: boolean;
  mastery: { head: number; heart: number; hands: number };
}

export async function assessGrade(
  itemKey: string,
  learnerExtKey: string,
  response: string,
): Promise<GradeResult> {
  const [item] = await db
    .select({
      id: schema.assessmentItems.id,
      objectiveId: schema.assessmentItems.objectiveId,
      objKey: schema.objectives.objKey,
      vector: schema.assessmentItems.vector,
      stem: schema.assessmentItems.stem,
      options: schema.assessmentItems.options,
      answerKey: schema.assessmentItems.answerKey,
    })
    .from(schema.assessmentItems)
    .innerJoin(schema.objectives, eq(schema.objectives.id, schema.assessmentItems.objectiveId))
    .where(eq(schema.assessmentItems.itemKey, itemKey))
    .limit(1);

  if (!item) throw new Error(`no item ${itemKey}`);

  const learner = await ensureLearner(learnerExtKey);
  const rubric = RUBRICS[item.vector] ?? RUBRICS.HEAD!;

  const grade = await structureFromImage<z.infer<typeof zGrade>>({
    system: gradeSystem(rubric),
    text: buildGradePrompt(item, response),
    schemaName: "emit_grade",
    schemaDescription: "Emit the anchored rubric grade for the learner's response.",
    schema: gradeSchema,
    validate: (i) => zGrade.parse(i),
    maxTokens: 1024,
  });

  const facultyFlag = grade.graderConfidence === "low";

  // Persist the attempt.
  await db.insert(schema.attempts).values({
    learnerId: learner.id,
    itemId: item.id,
    response,
    vector: item.vector,
    score: grade.score,
    anchorLabel: grade.anchorLabel,
    evidence: grade.evidence,
    graderConfidence: grade.graderConfidence,
    facultyFlag,
  });

  // Write mastery — this item's vector ONLY. Three vectors, never averaged.
  const vectorCol =
    item.vector === "HEART"
      ? { heart: grade.score }
      : item.vector === "HANDS"
        ? { hands: grade.score }
        : { head: grade.score };

  await db
    .insert(schema.mastery)
    .values({ learnerId: learner.id, objectiveId: item.objectiveId, ...vectorCol, lastAssessed: new Date() })
    .onConflictDoUpdate({
      target: [schema.mastery.learnerId, schema.mastery.objectiveId],
      set: { ...vectorCol, lastAssessed: new Date() },
    });

  // Log the error (with recurrence) if one was diagnosed.
  if (grade.errorType !== "none") {
    const [prior] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.errorLog)
      .where(
        and(
          eq(schema.errorLog.learnerId, learner.id),
          eq(schema.errorLog.objectiveId, item.objectiveId),
          eq(schema.errorLog.errorType, grade.errorType),
        ),
      );
    await db.insert(schema.errorLog).values({
      learnerId: learner.id,
      itemId: item.id,
      objectiveId: item.objectiveId,
      errorType: grade.errorType,
      description: grade.evidence,
      misconception: grade.misconception ?? null,
      recurrence: (prior?.n ?? 0) + 1,
    });
  }

  const [m] = await db
    .select({ head: schema.mastery.head, heart: schema.mastery.heart, hands: schema.mastery.hands })
    .from(schema.mastery)
    .where(and(eq(schema.mastery.learnerId, learner.id), eq(schema.mastery.objectiveId, item.objectiveId)))
    .limit(1);

  return {
    itemKey,
    objKey: item.objKey,
    vector: item.vector,
    score: grade.score,
    anchorLabel: grade.anchorLabel,
    evidence: grade.evidence,
    errorType: grade.errorType,
    ...(grade.misconception ? { misconception: grade.misconception } : {}),
    graderConfidence: grade.graderConfidence,
    facultyFlag,
    mastery: { head: m?.head ?? 0, heart: m?.heart ?? 0, hands: m?.hands ?? 0 },
  };
}

function gradeSystem(rubric: string): string {
  return `You are the grader of a 3H ophthalmology platform (Mode 4). Score the learner's response using ONLY this anchored rubric — do not invent levels:

${rubric}

Rules:
- Assign exactly one integer 0-4 and name the level.
- Quote the learner's own words as evidence.
- If the response reveals a specific error, name its type (knowledge/reasoning/technique/affect) and the misconception. Otherwise errorType is "none".
- Set graderConfidence low if the response is ambiguous, off-topic, or you are unsure — low grading is routed to a human.`;
}

function buildGradePrompt(
  item: { stem: string; options: unknown; answerKey: string | null },
  response: string,
): string {
  const opts = Array.isArray(item.options)
    ? (item.options as string[]).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n")
    : "";
  return `Question:
${item.stem}
${opts}
Correct answer: ${item.answerKey ?? "(open)"}

Learner's response:
${response}`;
}

async function ensureLearner(extKey: string) {
  const [existing] = await db
    .select()
    .from(schema.learners)
    .where(eq(schema.learners.extKey, extKey))
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(schema.learners).values({ extKey }).returning();
  return created!;
}
