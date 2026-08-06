import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { structureFromImage } from "../llm.js";
import type { GradeResult } from "./assess.js";

/**
 * MODE 5: FEEDBACK (THE MENTOR)
 *
 * Runs right after Mode 4 grades a batch of attempts. Not free-form
 * commentary — a fixed five-part sequence (Hattie & Timperley Feed-Up /
 * Feed-Back / Feed-Forward, wrapped in an R2C2-style relational open/close):
 * acknowledge -> restate the goal -> name the gap -> one next action -> close
 * steady. At most 2 correction targets per event (cognitive load) — the rest
 * of a bad quiz gets logged for the next loop, not dumped all at once.
 */

const FEEDBACK_SYSTEM = `You are the mentor of a 3H ophthalmology education platform (Mode 5: FEEDBACK).

Follow this exact five-part sequence — do not skip, reorder, or merge steps:
1. reaction (Heart): one genuine, SPECIFIC acknowledgment of effort or something done well. Never generic praise ("good job"). Reference something real from the attempt.
2. feedUp: restate the goal plainly — which objective this was testing and what level of performance it targets.
3. feedBack (Head/Hands): objective gap analysis. Quote the learner's own answer. Name the error type precisely (knowledge | reasoning | technique | affect) exactly as provided — never invent or relabel it.
4. feedForward: one metacognitive question ("what will you check before your next attempt?") PLUS exactly one concrete, checkable next action.
5. affectiveClose (Heart): normalize the error against a normal learning curve. End with calibrated confidence — not empty reassurance, not alarm.

Rules:
- Address ONLY the focus item(s) provided (at most 2) — never invent additional gaps beyond them, even if other items in the batch also scored low.
- If a focus item's errorType is "none", there is no real error to correct — reinforce what was done well instead of manufacturing a flaw, and use feedForward for a stretch goal rather than a correction.
- Ground every claim in the provided evidence and stem. Do not speculate beyond what was given.
- Keep the whole response under ~250 words total.`;

const FEEDBACK_SCHEMA_NAME = "emit_feedback";
const FEEDBACK_SCHEMA_DESCRIPTION =
  "Emit one structured Mode 5 feedback event: reaction, feed-up, feed-back, feed-forward, affective close.";

const FEEDBACK_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reaction: { type: "string", description: "Specific acknowledgment of effort or something done well." },
    feedUp: { type: "string", description: "Restate the objective and target level being assessed." },
    feedBack: { type: "string", description: "Gap analysis, quoting the learner's own answer, naming the error type." },
    feedForward: { type: "string", description: "One metacognitive question plus one concrete next action." },
    affectiveClose: { type: "string", description: "Normalize the error; end with calibrated confidence." },
  },
  required: ["reaction", "feedUp", "feedBack", "feedForward", "affectiveClose"],
};

/** Max words for the whole feedback event (§9 token budget: "feedback ≤ 250 words"). */
const MAX_FEEDBACK_WORDS = 250;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const zFeedback = z
  .object({
    reaction: z.string().min(1),
    feedUp: z.string().min(1),
    feedBack: z.string().min(1),
    feedForward: z.string().min(1),
    affectiveClose: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    const total =
      wordCount(data.reaction) +
      wordCount(data.feedUp) +
      wordCount(data.feedBack) +
      wordCount(data.feedForward) +
      wordCount(data.affectiveClose);
    if (total > MAX_FEEDBACK_WORDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `feedback is ${total} words total — must be ≤${MAX_FEEDBACK_WORDS}. Tighten it.`,
      });
    }
  });

export type FeedbackTurn = z.infer<typeof zFeedback>;

export interface FeedbackResult extends FeedbackTurn {
  /** Which objective(s) this feedback event actually focused on — at most 2. */
  focusObjKeys: string[];
  /** OBJ-xx keys added to the spaced-review queue as a direct result of this feedback's next action. */
  scheduledReview: string[];
}

/**
 * At most 2 correction targets per event (§5 cognitive load), worst-scoring
 * genuine error first. If nothing in the batch has a real diagnosed error,
 * fall back to the single best-scoring item — feedback still runs, it just
 * reinforces strength instead of correcting a gap that doesn't exist.
 */
function selectFocusItems(grades: GradeResult[]): GradeResult[] {
  const withErrors = grades.filter((g) => g.errorType !== "none");
  if (withErrors.length > 0) {
    return withErrors.sort((a, b) => a.score - b.score).slice(0, 2);
  }
  const best = grades.slice().sort((a, b) => b.score - a.score)[0];
  return best ? [best] : [];
}

/** Generate one Mode 5 feedback event from a just-graded batch of attempts. */
export async function generateFeedback(
  learnerExtKey: string,
  grades: GradeResult[],
): Promise<FeedbackResult | null> {
  if (grades.length === 0) return null;

  const focus = selectFocusItems(grades);
  if (focus.length === 0) return null;

  const learner = await ensureLearner(learnerExtKey);

  const turn = await structureFromImage<FeedbackTurn>({
    system: FEEDBACK_SYSTEM,
    text: buildFeedbackPrompt(grades, focus),
    schemaName: FEEDBACK_SCHEMA_NAME,
    schemaDescription: FEEDBACK_SCHEMA_DESCRIPTION,
    schema: FEEDBACK_INPUT_SCHEMA,
    validate: (input) => zFeedback.parse(input),
    maxTokens: 900,
  });

  const scheduledReview = await scheduleReviewForFocus(learner.id, focus);

  return {
    ...turn,
    focusObjKeys: focus.map((f) => f.objKey),
    scheduledReview,
  };
}

function buildFeedbackPrompt(all: GradeResult[], focus: GradeResult[]): string {
  const focusKeys = new Set(focus.map((f) => f.itemKey));
  const focusText = focus
    .map(
      (g) =>
        `[FOCUS] ${g.objKey} (${g.objStatement}) | vector ${g.vector} | score ${g.score}/4 (${g.anchorLabel}) | errorType: ${g.errorType}${g.misconception ? ` | misconception: ${g.misconception}` : ""}\nQuestion: ${g.stem}\nEvidence from learner's answer: ${g.evidence}`,
    )
    .join("\n\n");

  const restText = all
    .filter((g) => !focusKeys.has(g.itemKey))
    .map((g) => `${g.objKey}: ${g.score}/4 (${g.errorType})`)
    .join("; ");

  return `Give one Mode 5 feedback event for this learner's just-graded exam.

Focus item(s) — address ONLY these in your feed-back step (max 2):
${focusText}

${restText ? `Other items in this batch (context only, do NOT address these): ${restText}` : "This was the only item in the batch."}`;
}

/** Feed-forward's next action becomes a real spaced-review entry, same pattern Mode 3 already uses. */
async function scheduleReviewForFocus(learnerId: string, focus: GradeResult[]): Promise<string[]> {
  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // review in 1 day
  const objKeys: string[] = [];
  for (const g of focus) {
    await db
      .insert(schema.reviewQueue)
      .values({ learnerId, objectiveId: g.objectiveId, dueAt, intervalDays: 1 })
      .onConflictDoUpdate({
        target: [schema.reviewQueue.learnerId, schema.reviewQueue.objectiveId],
        set: { dueAt, intervalDays: 1 },
      });
    objKeys.push(g.objKey);
  }
  return objKeys;
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
