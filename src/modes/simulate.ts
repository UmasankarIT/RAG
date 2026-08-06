import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { structureFromImage } from "../llm.js";
import { retrieveNodesLexical } from "../retrieve/index.js";
import { RUBRICS, recordScore } from "./scoring.js";
import { generateFeedback, type FeedbackResult } from "./feedback.js";
import type { GradeResult } from "./assess.js";

/**
 * MODE 6: SIMULATION (THE STANDARDIZED PATIENT / OR) — §7 M6.
 *
 * start -> generate a hidden case (diagnosis, persona, 2-3 decision points
 *          tagged with real OBJ-ids) grounded in ingested nodes; return only
 *          the opening in-character turn.
 * turn  -> advance the case one exchange; reveal info only on the right
 *          action, track touched OBJ-ids silently, detect resolution.
 * end   -> learner-initiated stop.
 * Both turn (on resolution) and end auto-transition into a debrief that
 * scores the whole transcript per touched objective (MODE 4) and hands the
 * result to Mode 5 (generateFeedback), reusing the existing scoring/feedback
 * pipeline rather than inventing a parallel one.
 */

interface DecisionPoint {
  /** OBJ-xx — what the model reasons and echoes about; objectiveId is resolved from this server-side. */
  objKey: string;
  objectiveId: string;
  vector: string;
  description: string;
}

interface CaseState {
  diagnosis: string;
  persona: string;
  decisionPoints: DecisionPoint[];
}

interface CaseObjective {
  objectiveId: string;
  objKey: string;
  vector: string;
  statement: string;
}

// --- case generation ---------------------------------------------------

const CASE_GEN_SYSTEM = `You are the 3H Pedagogical Agent running Mode 6: SIMULATION (standardized patient / OR case).

Design ONE hidden case for the given topic, grounded ONLY in the provided knowledge nodes and objectives — never invent a drug dose, laser setting, or diagnostic threshold not present in the material.
- diagnosis: the hidden ground truth (a clinical diagnosis or scenario outcome), grounded in the nodes.
- persona: the patient's (or OR scenario's) persona and emotional arc — pick one that fits: anxious, angry, silent, over-talkative, or calm-but-worried. One or two sentences.
- decisionPoints: 2-3 embedded decision branch points. EACH must reference exactly one of the provided objective keys (e.g. "OBJ-07") verbatim (do not invent one) and its vector, plus a short description of what the learner needs to do or ask to hit it. Spread across different vectors where the objective pool allows — do not pick 3 from the same vector if others are available.
- openingTurn: the FIRST in-character message the learner sees — sets the scene (the patient's presenting complaint, or the OR setup), in the persona's voice. Do NOT reveal the diagnosis or any decision-point outcome yet.`;

const CASE_GEN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    diagnosis: { type: "string" },
    persona: { type: "string" },
    decisionPoints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          objKey: { type: "string", description: "Must be one of the provided objective keys (e.g. OBJ-07), verbatim." },
          vector: { type: "string", enum: ["HEAD", "HEART", "HANDS"] },
          description: { type: "string" },
        },
        required: ["objKey", "vector", "description"],
      },
    },
    openingTurn: { type: "string" },
  },
  required: ["title", "diagnosis", "persona", "decisionPoints", "openingTurn"],
};

const zCaseGen = z.object({
  title: z.string().min(1),
  diagnosis: z.string().min(1),
  persona: z.string().min(1),
  decisionPoints: z
    .array(
      z.object({
        objKey: z.string().min(1),
        vector: z.enum(["HEAD", "HEART", "HANDS"]),
        description: z.string().min(1),
      }),
    )
    .min(1),
  openingTurn: z.string().min(1),
});

export interface StartOptions {
  sourceKey?: string;
  reviewedOnly?: boolean;
}

export interface StartResult {
  simulationId: string;
  turnNumber: number;
  text: string;
}

const OBJECTIVE_POOL = 8;

/** Every distinct objective the topic's node pool teaches toward, up to OBJECTIVE_POOL. */
async function gatherObjectives(
  topic: string,
  opts: { sourceKey?: string; reviewedOnly: boolean },
): Promise<{ objectives: CaseObjective[]; nodesText: string }> {
  const nodes = await retrieveNodesLexical(topic, {
    limit: OBJECTIVE_POOL * 4,
    reviewedOnly: opts.reviewedOnly,
    ...(opts.sourceKey ? { sourceKey: opts.sourceKey } : {}),
  });
  if (nodes.length === 0) return { objectives: [], nodesText: "" };

  const knKeys = nodes.map((n) => n.knKey);
  const links = await db
    .selectDistinct({
      objectiveId: schema.objectives.id,
      objKey: schema.objectives.objKey,
      vector: schema.objectives.vector,
      statement: schema.objectives.statement,
    })
    .from(schema.nodeObjectives)
    .innerJoin(schema.knowledgeNodes, eq(schema.knowledgeNodes.id, schema.nodeObjectives.nodeId))
    .innerJoin(schema.objectives, eq(schema.objectives.id, schema.nodeObjectives.objectiveId))
    .where(inArray(schema.knowledgeNodes.knKey, knKeys))
    .limit(OBJECTIVE_POOL);

  const nodesText = nodes.map((n) => `[${n.knKey} | ${n.vector}] ${n.content}`).join("\n");
  return { objectives: links, nodesText };
}

export async function startSimulation(
  learnerExtKey: string,
  topic: string,
  options: StartOptions = {},
): Promise<StartResult> {
  const reviewedOnly = options.reviewedOnly ?? true;
  const learner = await ensureLearner(learnerExtKey);

  const { objectives, nodesText } = await gatherObjectives(topic, {
    reviewedOnly,
    ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
  });
  if (objectives.length === 0) {
    throw new Error(`no ${reviewedOnly ? "reviewed " : ""}objectives found to build a case for "${topic}"`);
  }

  const gen = await structureFromImage<z.infer<typeof zCaseGen>>({
    system: CASE_GEN_SYSTEM,
    text: buildCasePrompt(topic, objectives, nodesText),
    schemaName: "emit_case",
    schemaDescription: "Emit one hidden simulation case grounded in the provided objectives.",
    schema: CASE_GEN_SCHEMA,
    validate: (i) => zCaseGen.parse(i),
    maxTokens: 2048,
  });

  // R0.1-style grounding: resolve each decision point's objKey against the
  // objectives we actually provided (never trust a model-echoed UUID) and
  // drop any that don't resolve.
  const byObjKey = new Map(objectives.map((o) => [o.objKey, o]));
  const decisionPoints: DecisionPoint[] = gen.decisionPoints
    .map((d): DecisionPoint | null => {
      const objective = byObjKey.get(d.objKey);
      return objective
        ? { objKey: d.objKey, objectiveId: objective.objectiveId, vector: d.vector, description: d.description }
        : null;
    })
    .filter((d): d is DecisionPoint => d !== null);
  if (decisionPoints.length === 0) {
    throw new Error(`model grounded no decision point in a real objective for "${topic}"`);
  }

  const caseState: CaseState = { diagnosis: gen.diagnosis, persona: gen.persona, decisionPoints };

  const [simulation] = await db
    .insert(schema.simulations)
    .values({
      learnerId: learner.id,
      sourceKey: options.sourceKey ?? null,
      title: gen.title,
      caseState,
      status: "active",
    })
    .returning({ id: schema.simulations.id });

  await db.insert(schema.simulationTurns).values({
    simulationId: simulation!.id,
    turnNumber: 0,
    role: "agent",
    text: gen.openingTurn,
  });

  return { simulationId: simulation!.id, turnNumber: 0, text: gen.openingTurn };
}

function buildCasePrompt(topic: string, objectives: CaseObjective[], nodesText: string): string {
  const objText = objectives.map((o) => `${o.objKey} | ${o.vector}: ${o.statement}`).join("\n");
  return `Topic: "${topic}"

Objectives available for decision points (use their key verbatim, e.g. "OBJ-07"):
${objText}

Knowledge nodes for grounding:
${nodesText}`;
}

// --- turn advancement ----------------------------------------------------

const TURN_SYSTEM = `You are the 3H Pedagogical Agent running Mode 6: SIMULATION, in character as the patient/scenario persona described in the case. Respond turn-by-turn to the learner's actions and questions.

Rules:
- Stay in character. Reveal information ONLY when the learner asks the right question or takes the right action — never volunteer the diagnosis or skip ahead.
- Wrong or incomplete actions produce realistic consequences (e.g. the patient doesn't mention something relevant if not asked), not an immediate correction — this is the scenario unfolding, not a graded answer.
- If the learner's action/question matches one of the listed decision points, include that decision point's objKey in touchedObjKeys. Never tell the learner which objective this was — track it silently.
- Set caseResolved true only once the learner has reached a genuine conclusion (correct diagnosis/management stated, or they explicitly end the case) — otherwise false.
- Keep the in-character response concise and realistic, not a lecture.`;

const TURN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    responseText: { type: "string" },
    touchedObjKeys: { type: "array", items: { type: "string" } },
    caseResolved: { type: "boolean" },
  },
  required: ["responseText", "touchedObjKeys", "caseResolved"],
};

const zTurn = z.object({
  responseText: z.string().min(1),
  touchedObjKeys: z.array(z.string()).default([]),
  caseResolved: z.boolean(),
});

export interface TurnResult {
  simulationId: string;
  turnNumber: number;
  text: string;
  ended: boolean;
  debrief?: { grades: GradeResult[]; feedback: FeedbackResult | null };
}

async function loadActiveSimulation(simulationId: string, learnerId: string) {
  const [row] = await db
    .select()
    .from(schema.simulations)
    .where(
      and(
        eq(schema.simulations.id, simulationId),
        eq(schema.simulations.learnerId, learnerId),
        eq(schema.simulations.status, "active"),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`no active simulation ${simulationId} for this learner`);
  return row;
}

async function loadTurns(simulationId: string) {
  return db
    .select()
    .from(schema.simulationTurns)
    .where(eq(schema.simulationTurns.simulationId, simulationId))
    .orderBy(schema.simulationTurns.turnNumber);
}

export async function takeTurn(
  simulationId: string,
  learnerExtKey: string,
  action: string,
): Promise<TurnResult> {
  const learner = await ensureLearner(learnerExtKey);
  const simulation = await loadActiveSimulation(simulationId, learner.id);
  const caseState = simulation.caseState as CaseState;
  const history = await loadTurns(simulationId);
  const byObjKey = new Map(caseState.decisionPoints.map((d) => [d.objKey, d.objectiveId]));

  const turn = await structureFromImage<z.infer<typeof zTurn>>({
    system: TURN_SYSTEM,
    text: buildTurnPrompt(caseState, history, action),
    schemaName: "emit_sim_turn",
    schemaDescription: "Emit the next in-character simulation turn.",
    schema: TURN_SCHEMA,
    validate: (i) => zTurn.parse(i),
    maxTokens: 800,
  });

  // Resolve the model's echoed objKeys to real objectiveIds — never trust a
  // model-echoed UUID directly (see startSimulation's grounding comment).
  const touchedObjectiveIds = turn.touchedObjKeys
    .map((k) => byObjKey.get(k))
    .filter((id): id is string => id !== undefined);
  const nextTurnNumber = history.length;

  await db.insert(schema.simulationTurns).values({
    simulationId,
    turnNumber: nextTurnNumber,
    role: "learner",
    text: action,
    objectiveIds: touchedObjectiveIds.length > 0 ? touchedObjectiveIds : null,
  });
  await db.insert(schema.simulationTurns).values({
    simulationId,
    turnNumber: nextTurnNumber + 1,
    role: "agent",
    text: turn.responseText,
  });

  if (!turn.caseResolved) {
    return { simulationId, turnNumber: nextTurnNumber + 1, text: turn.responseText, ended: false };
  }

  const debriefResult = await debrief(simulationId, learner.id, simulation.title, caseState);
  return {
    simulationId,
    turnNumber: nextTurnNumber + 1,
    text: turn.responseText,
    ended: true,
    debrief: debriefResult,
  };
}

function buildTurnPrompt(
  caseState: CaseState,
  history: { role: string; text: string }[],
  action: string,
): string {
  const decisionText = caseState.decisionPoints
    .map((d) => `${d.objKey} [${d.vector}]: ${d.description}`)
    .join("\n");
  const historyText = history.map((t) => `${t.role === "learner" ? "LEARNER" : "AGENT"}: ${t.text}`).join("\n");
  return `Hidden diagnosis (never reveal directly): ${caseState.diagnosis}
Persona: ${caseState.persona}

Decision points (track silently, do not name to the learner):
${decisionText}

Transcript so far:
${historyText}

Learner's new action:
${action}`;
}

/** Learner-initiated stop — same debrief as natural case resolution. */
export async function endSimulation(
  simulationId: string,
  learnerExtKey: string,
): Promise<{ grades: GradeResult[]; feedback: FeedbackResult | null }> {
  const learner = await ensureLearner(learnerExtKey);
  const simulation = await loadActiveSimulation(simulationId, learner.id);
  const caseState = simulation.caseState as CaseState;
  return debrief(simulationId, learner.id, simulation.title, caseState);
}

// --- debrief (Mode 4 scoring -> Mode 5 feedback) --------------------------

const DEBRIEF_SYSTEM = `You are the examiner of a 3H ophthalmology platform, running a debrief for a just-ended Mode 6 simulation. Score the learner's performance across the WHOLE case transcript against EACH listed objective's own anchored rubric — do not invent levels, and never average across objectives or vectors.

For every objective listed, output one scored entry:
- objKey: the objective's key from the list, verbatim (e.g. "OBJ-07").
- score: exact anchor 0-4 for that objective's rubric.
- anchorLabel: the rubric level name you assigned.
- evidence: a quote or paraphrase from the learner's own turns in the transcript.
- errorType: knowledge | reasoning | technique | affect | none.
- misconception: the specific misconception shown, if any.
- graderConfidence: high | medium | low — low routes to human review.`;

const DEBRIEF_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          objKey: { type: "string", description: "The objective key (e.g. OBJ-07) from the list provided, verbatim." },
          score: { type: "integer" },
          anchorLabel: { type: "string" },
          evidence: { type: "string" },
          errorType: { type: "string", enum: ["knowledge", "reasoning", "technique", "affect", "none"] },
          misconception: { type: "string" },
          graderConfidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["objKey", "score", "anchorLabel", "evidence", "errorType", "graderConfidence"],
      },
    },
  },
  required: ["scores"],
};

const zDebrief = z.object({
  scores: z
    .array(
      z.object({
        objKey: z.string().min(1),
        score: z.number().int().min(0).max(4),
        anchorLabel: z.string(),
        evidence: z.string(),
        errorType: z.enum(["knowledge", "reasoning", "technique", "affect", "none"]),
        misconception: z.string().optional(),
        graderConfidence: z.enum(["high", "medium", "low"]),
      }),
    )
    .min(1),
});

async function debrief(
  simulationId: string,
  learnerId: string,
  title: string,
  caseState: CaseState,
): Promise<{ grades: GradeResult[]; feedback: FeedbackResult | null }> {
  await db
    .update(schema.simulations)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(schema.simulations.id, simulationId));

  const history = await loadTurns(simulationId);
  const touchedIds = [
    ...new Set(
      history.flatMap((t) => (Array.isArray(t.objectiveIds) ? (t.objectiveIds as string[]) : [])),
    ),
  ];
  // If the learner never triggered a decision point, fall back to the
  // case's full decision-point set so the debrief still has something to
  // score rather than returning nothing.
  const scoreTargetIds = touchedIds.length > 0 ? touchedIds : caseState.decisionPoints.map((d) => d.objectiveId);

  const objectives = await db
    .select({
      id: schema.objectives.id,
      objKey: schema.objectives.objKey,
      vector: schema.objectives.vector,
      statement: schema.objectives.statement,
    })
    .from(schema.objectives)
    .where(inArray(schema.objectives.id, scoreTargetIds));
  if (objectives.length === 0) return { grades: [], feedback: null };

  const transcriptText = history.map((t) => `${t.role === "learner" ? "LEARNER" : "AGENT"}: ${t.text}`).join("\n");

  const result = await structureFromImage<z.infer<typeof zDebrief>>({
    system: DEBRIEF_SYSTEM,
    text: buildDebriefPrompt(objectives, transcriptText),
    schemaName: "emit_debrief",
    schemaDescription: "Emit one anchored-rubric score per objective for this simulation transcript.",
    schema: DEBRIEF_SCHEMA,
    validate: (i) => zDebrief.parse(i),
    maxTokens: 2048,
  });

  const objectivesByObjKey = new Map(objectives.map((o) => [o.objKey, o]));
  const grades: GradeResult[] = [];

  for (const s of result.scores) {
    const objective = objectivesByObjKey.get(s.objKey);
    if (!objective) continue; // grounding safety — ignore any hallucinated key

    const [item] = await db
      .insert(schema.assessmentItems)
      .values({
        itemKey: randomUUID(), // temp unique placeholder; set to ITEM-<seq> below
        objectiveId: objective.id,
        vector: objective.vector,
        itemType: "SIM",
        stem: `Simulation debrief — ${title}`,
      })
      .returning({ id: schema.assessmentItems.id, seq: schema.assessmentItems.seq });

    const itemKey = `ITEM-${item!.seq}`;
    await db.update(schema.assessmentItems).set({ itemKey }).where(eq(schema.assessmentItems.id, item!.id));

    const mastery = await recordScore({
      learnerId,
      itemId: item!.id,
      objectiveId: objective.id,
      vector: objective.vector,
      response: transcriptText,
      score: s.score,
      anchorLabel: s.anchorLabel,
      evidence: s.evidence,
      errorType: s.errorType,
      ...(s.misconception ? { misconception: s.misconception } : {}),
      graderConfidence: s.graderConfidence,
    });

    grades.push({
      itemKey,
      objKey: objective.objKey,
      objStatement: objective.statement,
      objectiveId: objective.id,
      stem: `Simulation debrief — ${title}`,
      vector: objective.vector,
      score: s.score,
      anchorLabel: s.anchorLabel,
      evidence: s.evidence,
      errorType: s.errorType,
      ...(s.misconception ? { misconception: s.misconception } : {}),
      graderConfidence: s.graderConfidence,
      facultyFlag: s.graderConfidence === "low",
      mastery,
      correctAnswerKey: null,
    });
  }

  // Grades are already scored and persisted (attempts/mastery/errorLog) above
  // — a Mode 5 failure shouldn't destroy that, so it's caught rather than
  // left to propagate and 500 the whole debrief (mirrors how the frontend's
  // assess flow already treats grading and feedback as separable steps).
  const learnerRow = await db
    .select({ extKey: schema.learners.extKey })
    .from(schema.learners)
    .where(eq(schema.learners.id, learnerId))
    .limit(1);
  let feedback: FeedbackResult | null = null;
  if (learnerRow[0]) {
    try {
      feedback = await generateFeedback(learnerRow[0].extKey, grades);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`simulate debrief: feedback generation failed — ${msg}`);
    }
  }

  return { grades, feedback };
}

function buildDebriefPrompt(
  objectives: { id: string; objKey: string; vector: string; statement: string }[],
  transcriptText: string,
): string {
  const objText = objectives
    .map((o) => `${o.objKey} | ${o.vector}: ${o.statement}\nRubric:\n${RUBRICS[o.vector] ?? RUBRICS.HEAD}`)
    .join("\n\n");
  return `Objectives to score (use each key verbatim, e.g. "OBJ-07"):
${objText}

Full simulation transcript:
${transcriptText}`;
}

async function ensureLearner(extKey: string) {
  const [existing] = await db.select().from(schema.learners).where(eq(schema.learners.extKey, extKey)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(schema.learners).values({ extKey }).returning();
  return created!;
}
