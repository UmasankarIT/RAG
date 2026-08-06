import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { structureFromImage } from "../llm.js";

/**
 * MODE 2: CURRICULUM & OBJECTIVES (THE PLANNER)
 *
 * Stateless — reasons fresh over current learner state every time, no saved
 * "plan" of its own. Two of its four outputs (what's due for review, which
 * vectors a source is missing) are deterministic, computed in code from data
 * Modes 3/4/5 already write — only the sequencing itself needs an LLM call,
 * since no prerequisite graph exists anywhere in this schema to compute one
 * mechanically. See modes/curriculum.ts comment on the "coverage" reading.
 */

const VECTORS = ["HEAD", "HEART", "HANDS"] as const;

interface ObjectiveRow {
  id: string;
  objKey: string;
  vector: string;
  taxonomyLevel: string | null;
  statement: string;
  sourceId: string;
  sourceKey: string;
  sourceTitle: string | null;
  headScore: number | null;
  heartScore: number | null;
  handsScore: number | null;
}

function scoreFor(row: ObjectiveRow): number {
  if (row.vector === "HEART") return row.heartScore ?? 0;
  if (row.vector === "HANDS") return row.handsScore ?? 0;
  return row.headScore ?? 0;
}

export interface DueReviewItem {
  objKey: string;
  statement: string;
  dueAt: string;
}

export interface CoverageGap {
  sourceKey: string;
  sourceTitle: string | null;
  /** Which of HEAD/HEART/HANDS have no objective at all for this source. */
  missingVectors: string[];
}

export interface SequencedObjective {
  objKey: string;
  statement: string;
  vector: string;
  taxonomyLevel: string | null;
  rationale: string;
}

export interface CurriculumResult {
  entryPoint: SequencedObjective | null;
  /** Up to 5 further objectives after the entry point, in order. */
  sequence: SequencedObjective[];
  dueForReview: DueReviewItem[];
  coverageGaps: CoverageGap[];
}

export interface CurriculumOptions {
  sourceKey?: string;
}

/** Objectives grouped by source, present vectors only — the deterministic half of "coverage." */
function computeCoverageGaps(objectives: ObjectiveRow[]): CoverageGap[] {
  const bySource = new Map<string, { sourceKey: string; sourceTitle: string | null; vectors: Set<string> }>();
  for (const o of objectives) {
    const entry = bySource.get(o.sourceId) ?? {
      sourceKey: o.sourceKey,
      sourceTitle: o.sourceTitle,
      vectors: new Set<string>(),
    };
    entry.vectors.add(o.vector);
    bySource.set(o.sourceId, entry);
  }

  const gaps: CoverageGap[] = [];
  for (const entry of bySource.values()) {
    const missing = VECTORS.filter((v) => !entry.vectors.has(v));
    if (missing.length > 0) {
      gaps.push({ sourceKey: entry.sourceKey, sourceTitle: entry.sourceTitle, missingVectors: missing });
    }
  }
  return gaps;
}

const SEQUENCE_SYSTEM = `You are the curriculum planner of a 3H ophthalmology education platform (Mode 2: CURRICULUM).

You are given a learner's already-mastered objectives and a pool of candidate objectives they have not yet mastered. Produce a sensible next-study plan:
- entryPointObjKey: the ONE objective to tackle next. Match it to their current level — building on what they already know, not requiring groundwork they don't have, and not something they've effectively already mastered.
- sequence: up to 5 further objectives after the entry point, in a sensible order, each with a one-sentence rationale tying it to what came before or to the learner's mastered material.

Rules:
- Only reference objKeys from the provided candidate list — never invent one.
- A higher taxonomy level generally implies more prerequisite groundwork — don't sequence something advanced before a simpler related objective that's also in the pool.
- If the learner has mastered nothing yet, the entry point should be the most foundational (lowest taxonomy level) candidate available.
- If two candidates are equally reasonable, prefer the one whose vector (HEAD/HEART/HANDS) is least represented among what's already mastered — spread learning across all three, not just one.`;

const SEQUENCE_SCHEMA_NAME = "emit_curriculum_sequence";
const SEQUENCE_SCHEMA_DESCRIPTION = "Emit the entry point and ordered next-objective sequence.";

const SEQUENCE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    entryPointObjKey: { type: "string" },
    entryPointRationale: { type: "string" },
    sequence: {
      type: "array",
      description: "Up to 5 objectives to tackle after the entry point, in order.",
      items: {
        type: "object",
        properties: {
          objKey: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["objKey", "rationale"],
      },
    },
  },
  required: ["entryPointObjKey", "entryPointRationale", "sequence"],
};

const zSequence = z.object({
  entryPointObjKey: z.string().min(1),
  entryPointRationale: z.string().min(1),
  sequence: z.array(z.object({ objKey: z.string().min(1), rationale: z.string().min(1) })).max(8),
});

/** How many not-yet-mastered candidates to offer the model, and how much mastery context to give it. */
const CANDIDATE_POOL = 30;
const MASTERED_CONTEXT_LIMIT = 10;

export async function generateCurriculum(
  learnerExtKey: string,
  options: CurriculumOptions = {},
): Promise<CurriculumResult> {
  const learner = await ensureLearner(learnerExtKey);

  const rows = await db
    .select({
      id: schema.objectives.id,
      objKey: schema.objectives.objKey,
      vector: schema.objectives.vector,
      taxonomyLevel: schema.objectives.taxonomyLevel,
      statement: schema.objectives.statement,
      sourceId: schema.objectives.sourceId,
      sourceKey: schema.sources.sourceKey,
      sourceTitle: schema.sources.title,
      headScore: schema.mastery.head,
      heartScore: schema.mastery.heart,
      handsScore: schema.mastery.hands,
    })
    .from(schema.objectives)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.objectives.sourceId))
    .leftJoin(
      schema.mastery,
      and(eq(schema.mastery.objectiveId, schema.objectives.id), eq(schema.mastery.learnerId, learner.id)),
    )
    .where(options.sourceKey ? eq(schema.sources.sourceKey, options.sourceKey) : undefined);

  const coverageGaps = computeCoverageGaps(rows);

  const dueRows = await db
    .select({ objKey: schema.objectives.objKey, statement: schema.objectives.statement, dueAt: schema.reviewQueue.dueAt })
    .from(schema.reviewQueue)
    .innerJoin(schema.objectives, eq(schema.objectives.id, schema.reviewQueue.objectiveId))
    .where(and(eq(schema.reviewQueue.learnerId, learner.id), lte(schema.reviewQueue.dueAt, new Date())))
    .orderBy(asc(schema.reviewQueue.dueAt));
  const dueForReview: DueReviewItem[] = dueRows.map((r) => ({
    objKey: r.objKey,
    statement: r.statement,
    dueAt: r.dueAt.toISOString(),
  }));

  const mastered = rows.filter((r) => scoreFor(r) >= 3);
  const candidates = rows.filter((r) => scoreFor(r) < 3).slice(0, CANDIDATE_POOL);

  if (candidates.length === 0) {
    return { entryPoint: null, sequence: [], dueForReview, coverageGaps };
  }

  const byObjKey = new Map(candidates.map((c) => [c.objKey, c]));

  const plan = await structureFromImage<z.infer<typeof zSequence>>({
    system: SEQUENCE_SYSTEM,
    text: buildSequencePrompt(mastered.slice(0, MASTERED_CONTEXT_LIMIT), candidates),
    schemaName: SEQUENCE_SCHEMA_NAME,
    schemaDescription: SEQUENCE_SCHEMA_DESCRIPTION,
    schema: SEQUENCE_INPUT_SCHEMA,
    validate: (input) => zSequence.parse(input),
    maxTokens: 1200,
  });

  const toSequenced = (objKey: string, rationale: string): SequencedObjective | null => {
    const row = byObjKey.get(objKey);
    if (!row) return null; // model referenced something outside the candidate pool
    return { objKey: row.objKey, statement: row.statement, vector: row.vector, taxonomyLevel: row.taxonomyLevel, rationale };
  };

  const entryPoint = toSequenced(plan.entryPointObjKey, plan.entryPointRationale);
  const sequence = plan.sequence
    .map((s) => toSequenced(s.objKey, s.rationale))
    .filter((s): s is SequencedObjective => s !== null)
    .slice(0, 5);

  return { entryPoint, sequence, dueForReview, coverageGaps };
}

function buildSequencePrompt(mastered: ObjectiveRow[], candidates: ObjectiveRow[]): string {
  const masteredText = mastered.length
    ? mastered.map((m) => `${m.objKey} [${m.vector}]: ${m.statement}`).join("\n")
    : "(nothing mastered yet — this learner is new)";

  const candidateText = candidates
    .map((c) => `${c.objKey} [${c.vector} | ${c.taxonomyLevel ?? "n/a"}]: ${c.statement}`)
    .join("\n");

  return `Already mastered:\n${masteredText}\n\nCandidate objectives (not yet mastered):\n${candidateText}`;
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
