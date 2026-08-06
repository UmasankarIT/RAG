import { z } from "zod";
import { structureFromImage } from "../llm.js";

/**
 * MODE 0: SESSION ORCHESTRATION — §6 Mode Router.
 *
 * Classifies a free-text message into which mode should handle it (§6.1).
 * Only handles FRESH, single-turn requests ("explain X", "quiz me on X",
 * "plan my study", "simulate a case") — grading a specific answer or
 * generating feedback needs state (an itemKey, prior grades) a bare message
 * doesn't carry, so those stay on their explicit, structured endpoints
 * (/api/assess/grade(-batch), /api/assess/feedback) rather than routing
 * through here. Per R0.5, ambiguous input gets the §6.3 fallback question
 * instead of a guess.
 */

export const ROUTER_MODES = ["TEACH", "ASSESS", "CURRICULUM", "SIMULATE", "INGEST", "UNCLEAR"] as const;
export type RouterMode = (typeof ROUTER_MODES)[number];

export const FALLBACK_TEXT =
  "I can **teach**, **assess**, **give feedback**, **simulate a case**, or **process new content**. Which one, and on what topic?";

const ROUTER_SYSTEM = `You are the router of a 3H ophthalmology education platform (Mode 0: SESSION ORCHESTRATION).

Classify the learner's message into exactly one mode, per this table:
- Raw text/transcript/chapter/guideline content to process -> INGEST
- "Explain / teach / why / how does..." -> TEACH
- "Quiz me / test me / give me questions" -> ASSESS
- "Give me a case / simulate a patient / role-play" -> SIMULATE
- "Plan my learning / what should I study" -> CURRICULUM
- Anything else, or genuinely ambiguous between two modes -> UNCLEAR

Rules:
- Never guess silently — if confidence isn't high, set mode to UNCLEAR and confidence to match your real uncertainty.
- If a mode is chosen, extract the topic the learner wants (a short phrase), if one is present in the message.`;

const ROUTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: { type: "string", enum: [...ROUTER_MODES] },
    topic: { type: "string", description: "The topic the learner wants, if present in the message." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["mode", "confidence"],
};

const zRouter = z.object({
  mode: z.enum(ROUTER_MODES),
  topic: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
});

export interface RouterDecision {
  mode: RouterMode;
  topic?: string;
  confidence: "high" | "medium" | "low";
}

export async function classifyIntent(message: string): Promise<RouterDecision> {
  const decision = await structureFromImage<z.infer<typeof zRouter>>({
    system: ROUTER_SYSTEM,
    text: `Learner message: "${message}"`,
    schemaName: "emit_route",
    schemaDescription: "Emit the mode this message should route to.",
    schema: ROUTER_SCHEMA,
    validate: (i) => zRouter.parse(i),
    maxTokens: 256,
  });
  return decision;
}
