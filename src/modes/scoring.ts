import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/**
 * Shared §8 anchored rubrics (verbatim; R0.6) and the score-write path
 * (attempts + mastery + errorLog) — used by Mode 4 (assess.ts, a single
 * MCQ/short-answer item) and Mode 6 (simulate.ts, a whole case transcript
 * scored per touched objective). Kept in one place so both callers write
 * mastery identically and never invent a new scale.
 */

export const RUBRICS: Record<string, string> = {
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

export interface RecordScoreInput {
  learnerId: string;
  itemId: string;
  objectiveId: string;
  vector: string;
  /** The learner's raw response/transcript this score was derived from — stored verbatim in attempts.response. */
  response: string;
  score: number;
  anchorLabel: string;
  /** Quote/paraphrase justifying the score — stored in attempts.evidence and errorLog.description. */
  evidence: string;
  errorType: string;
  misconception?: string;
  graderConfidence: string;
}

export interface MasteryVector {
  head: number;
  heart: number;
  hands: number;
}

/**
 * Persist one scored attempt: the attempts row (audit trail), the mastery
 * upsert (that item's vector ONLY — never averaged across vectors, §7 M4),
 * and an errorLog entry (with recurrence) if a real error was diagnosed.
 * Returns the learner's resulting mastery on this objective.
 */
export async function recordScore(input: RecordScoreInput): Promise<MasteryVector> {
  const facultyFlag = input.graderConfidence === "low";

  await db.insert(schema.attempts).values({
    learnerId: input.learnerId,
    itemId: input.itemId,
    response: input.response,
    vector: input.vector,
    score: input.score,
    anchorLabel: input.anchorLabel,
    evidence: input.evidence,
    graderConfidence: input.graderConfidence,
    facultyFlag,
  });

  const vectorCol =
    input.vector === "HEART"
      ? { heart: input.score }
      : input.vector === "HANDS"
        ? { hands: input.score }
        : { head: input.score };

  await db
    .insert(schema.mastery)
    .values({ learnerId: input.learnerId, objectiveId: input.objectiveId, ...vectorCol, lastAssessed: new Date() })
    .onConflictDoUpdate({
      target: [schema.mastery.learnerId, schema.mastery.objectiveId],
      set: { ...vectorCol, lastAssessed: new Date() },
    });

  if (input.errorType !== "none") {
    const [prior] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.errorLog)
      .where(
        and(
          eq(schema.errorLog.learnerId, input.learnerId),
          eq(schema.errorLog.objectiveId, input.objectiveId),
          eq(schema.errorLog.errorType, input.errorType),
        ),
      );
    await db.insert(schema.errorLog).values({
      learnerId: input.learnerId,
      itemId: input.itemId,
      objectiveId: input.objectiveId,
      errorType: input.errorType,
      description: input.evidence,
      misconception: input.misconception ?? null,
      recurrence: (prior?.n ?? 0) + 1,
    });
  }

  const [m] = await db
    .select({ head: schema.mastery.head, heart: schema.mastery.heart, hands: schema.mastery.hands })
    .from(schema.mastery)
    .where(and(eq(schema.mastery.learnerId, input.learnerId), eq(schema.mastery.objectiveId, input.objectiveId)))
    .limit(1);

  return { head: m?.head ?? 0, heart: m?.heart ?? 0, hands: m?.hands ?? 0 };
}
