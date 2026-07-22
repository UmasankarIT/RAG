import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { structureFromImage } from "../llm.js";

/**
 * MODE 1: CONTENT INGESTION → 3H KNOWLEDGE GRAPH
 *
 * Claude reads ONE rasterized page image and returns structured pedagogical
 * content: knowledge nodes (tagged HEAD/HEART/HANDS), learning objectives,
 * misconceptions, assessment seeds, and a gap report. The model proposes
 * content only — code assigns the KN-/OBJ-/AI- citation keys downstream, so a
 * cited id always resolves to a real row (R0.1).
 */

const SYSTEM_PROMPT = `You are the ingestion engine of a 3H medical-education platform (domain: Ophthalmology).

You are given ONE page image from course material. Extract its teachable content into a structured knowledge graph across the three 3H vectors:
- HEAD  — cognitive: facts, mechanisms, diagnostic criteria, classifications.
- HEART — affective: patient perspective, ethics, consent, communication moments.
- HANDS — psychomotor: procedural steps, parameters, checkpoints, error-recovery.

Rules:
- Ground everything in what is visible on THIS page — body text, figures, labels, diagrams. Do not add facts from outside the page.
- Never invent drug doses, laser parameters, surgical settings, or diagnostic thresholds that are not shown.
- Each knowledge node states ONE idea, tagged with exactly one vector.
- Each objective has a 3H vector, a taxonomy level (e.g. Bloom-Apply, Dave-Precision, SOLO-Relational), and an observable statement with an action verb.
- Link objectives to the nodes that teach them via nodeRefs (0-based indices into the nodes array).
- For each objective, give 2-3 assessment item seeds (stems only).
- Report per-vector gaps: what a complete treatment would cover that THIS page does not (e.g. "covers technique [HANDS] but silent on consent [HEART]").
- Do NOT assign any IDs — the platform assigns them.`;

const INSTRUCTION = `Structure this page into the 3H knowledge graph. Call the emit_knowledge_graph tool with the result.`;

// --- Output contract: the forced tool's input schema -----------------------

const VECTOR_ENUM = ["HEAD", "HEART", "HANDS"] as const;

const tool: Anthropic.Tool = {
  name: "emit_knowledge_graph",
  description:
    "Emit the structured 3H knowledge graph extracted from the page image.",
  input_schema: {
    type: "object",
    properties: {
      nodes: {
        type: "array",
        description: "Knowledge nodes, one idea each.",
        items: {
          type: "object",
          properties: {
            vector: { type: "string", enum: [...VECTOR_ENUM] },
            nodeType: {
              type: "string",
              description: "fact | mechanism | criterion | classification | step | checkpoint | ethical-tension | communication",
            },
            title: { type: "string" },
            content: { type: "string", description: "The node's factual content." },
            misconceptions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  distractorLogic: { type: "string" },
                },
                required: ["description"],
              },
            },
          },
          required: ["vector", "content"],
        },
      },
      objectives: {
        type: "array",
        items: {
          type: "object",
          properties: {
            vector: { type: "string", enum: [...VECTOR_ENUM] },
            taxonomyLevel: { type: "string" },
            statement: { type: "string" },
            nodeRefs: {
              type: "array",
              description: "0-based indices into nodes that teach this objective.",
              items: { type: "integer" },
            },
            seeds: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  itemType: {
                    type: "string",
                    description: "MCQ | short-answer | script-concordance | key-feature | osce-checklist",
                  },
                  stem: { type: "string" },
                },
                required: ["stem"],
              },
            },
          },
          required: ["vector", "statement"],
        },
      },
      gaps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            vector: { type: "string", enum: [...VECTOR_ENUM] },
            description: { type: "string" },
          },
          required: ["description"],
        },
      },
    },
    required: ["nodes", "objectives"],
  },
};

// --- Validation (Zod mirror of the schema) ---------------------------------

const zVector = z.enum(VECTOR_ENUM);

const zMisconception = z.object({
  description: z.string().min(1),
  distractorLogic: z.string().optional(),
});

const zNode = z.object({
  vector: zVector,
  nodeType: z.string().optional(),
  title: z.string().optional(),
  content: z.string().min(1),
  misconceptions: z.array(zMisconception).optional(),
});

const zSeed = z.object({
  itemType: z.string().optional(),
  stem: z.string().min(1),
});

const zObjective = z.object({
  vector: zVector,
  taxonomyLevel: z.string().optional(),
  statement: z.string().min(1),
  nodeRefs: z.array(z.number().int().nonnegative()).optional(),
  seeds: z.array(zSeed).optional(),
});

const zGap = z.object({
  vector: zVector.optional(),
  description: z.string().min(1),
});

const zOutput = z.object({
  nodes: z.array(zNode),
  objectives: z.array(zObjective),
  gaps: z.array(zGap).optional(),
});

export type Mode1Output = z.infer<typeof zOutput>;
export type Mode1Node = z.infer<typeof zNode>;
export type Mode1Objective = z.infer<typeof zObjective>;

/** Structure one page image into the 3H knowledge graph. */
export async function structurePage(imageBase64: string): Promise<Mode1Output> {
  return structureFromImage<Mode1Output>({
    system: SYSTEM_PROMPT,
    text: INSTRUCTION,
    imageBase64,
    tool,
    validate: (input) => zOutput.parse(input),
  });
}
