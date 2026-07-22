import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";

/**
 * The single LLM boundary. Every model call in the system goes through here —
 * Mode 1 structuring, the mode router, answer generation. The modes are
 * provider-agnostic: they hand us a system prompt, an image, a JSON schema, and
 * a validator, and get back a validated object. Which backend runs (Claude or,
 * for testing, Gemini) is decided by LLM_PROVIDER — a one-line env change.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for errors worth retrying (rate limit / overload / 5xx / transient net). */
function isTransient(error: unknown): boolean {
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    return error.status === 429 || error.status === 408 || error.status >= 500;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /\b(408|429|50\d|503|529)\b|overloaded|unavailable|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    msg,
  );
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (!isTransient(error) || attempt === maxAttempts) throw error;
      const waitMs = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s
      console.log(
        `  ${label}: transient error, retrying in ${waitMs / 1000}s (${attempt}/${maxAttempts - 1})`,
      );
      await sleep(waitMs);
    }
  }
  throw new Error("unreachable");
}

// --- lazy clients (only the active provider's key is required) -------------

let anthropic: Anthropic | null = null;
function claude(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }));
}

let genai: GoogleGenAI | null = null;
function gemini(): GoogleGenAI {
  return (genai ??= new GoogleGenAI({ apiKey: config.GEMINI_API_KEY ?? "" }));
}

export type ImageMediaType = "image/png" | "image/jpeg";

export interface StructureFromImageParams<T> {
  /** System prompt — the mode's role and output contract. */
  system: string;
  /** The instruction accompanying the image. */
  text: string;
  imageBase64: string;
  imageMediaType?: ImageMediaType;
  /** Name/description of the structured payload (used as the Claude tool name). */
  schemaName: string;
  schemaDescription: string;
  /** Plain JSON Schema for the payload. */
  schema: Record<string, unknown>;
  /** Validate + narrow the model's output. Throw to reject (triggers one retry). */
  validate: (input: unknown) => T;
  maxTokens?: number;
}

/**
 * Send a page image to the active LLM and get back a validated structured
 * object. On a schema miss we hand the error back to the model once and let it
 * correct itself before giving up.
 */
export async function structureFromImage<T>(
  params: StructureFromImageParams<T>,
): Promise<T> {
  return config.LLM_PROVIDER === "gemini"
    ? geminiStructure(params)
    : claudeStructure(params);
}

// --- free-form multimodal generation (Mode 3 Teach, later Modes 5/6) -------

export interface GenerateImage {
  base64: string;
  mediaType?: ImageMediaType;
  /** Shown to the model as a caption before the image (e.g. a source label). */
  label?: string;
}

export interface GenerateParams {
  system: string;
  text: string;
  images?: GenerateImage[];
  maxTokens?: number;
}

/** Generate free-form text from a prompt plus optional page images. */
export async function generate(params: GenerateParams): Promise<string> {
  return config.LLM_PROVIDER === "gemini"
    ? geminiGenerate(params)
    : claudeGenerate(params);
}

async function claudeGenerate(p: GenerateParams): Promise<string> {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: p.text }];
  for (const img of p.images ?? []) {
    if (img.label) content.push({ type: "text", text: img.label });
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType ?? "image/png", data: img.base64 },
    });
  }

  const response = await withRetry(
    () =>
      claude().messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: p.maxTokens ?? 2048,
        system: p.system,
        messages: [{ role: "user", content }],
      }),
    "generate",
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("generate: model returned no text");
  return text;
}

async function geminiGenerate(p: GenerateParams): Promise<string> {
  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [{ text: p.text }];
  for (const img of p.images ?? []) {
    if (img.label) parts.push({ text: img.label });
    parts.push({ inlineData: { mimeType: img.mediaType ?? "image/png", data: img.base64 } });
  }

  const response = await withRetry(
    () =>
      gemini().models.generateContent({
        model: config.GEMINI_MODEL,
        contents: parts,
        config: {
          systemInstruction: p.system,
          maxOutputTokens: p.maxTokens ?? 2048,
        },
      }),
    "generate",
  );

  const text = response.text?.trim();
  if (!text) throw new Error("generate: gemini returned no text");
  return text;
}

// --- Claude: forced tool call guarantees structured output -----------------

async function claudeStructure<T>(p: StructureFromImageParams<T>): Promise<T> {
  const media = p.imageMediaType ?? "image/png";
  const tool: Anthropic.Tool = {
    name: p.schemaName,
    description: p.schemaDescription,
    input_schema: p.schema as Anthropic.Tool.InputSchema,
  };

  let correction = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await withRetry(
      () =>
        claude().messages.create({
          model: config.ANTHROPIC_MODEL,
          max_tokens: p.maxTokens ?? 8192,
          system: p.system,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: p.text + correction },
                { type: "image", source: { type: "base64", media_type: media, data: p.imageBase64 } },
              ],
            },
          ],
        }),
      p.schemaName,
    );

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error(`${p.schemaName}: model returned no tool call`);
    }

    try {
      return p.validate(block.input);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 2) throw new Error(`${p.schemaName}: output failed validation — ${msg}`);
      correction = `\n\nYour previous tool call did not match the schema:\n${msg}\nReturn it again, corrected.`;
    }
  }
  throw new Error("unreachable");
}

// --- Gemini: JSON mime type + prompt-embedded schema (testing stand-in) ----

async function geminiStructure<T>(p: StructureFromImageParams<T>): Promise<T> {
  const media = p.imageMediaType ?? "image/png";

  let correction = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await withRetry(
      () =>
        gemini().models.generateContent({
          model: config.GEMINI_MODEL,
          contents: [
            {
              text:
                `${p.text}\n\nReturn ONLY a JSON object matching this JSON Schema ` +
                `(no markdown, no commentary):\n${JSON.stringify(p.schema)}${correction}`,
            },
            { inlineData: { mimeType: media, data: p.imageBase64 } },
          ],
          config: {
            systemInstruction: p.system,
            responseMimeType: "application/json",
            maxOutputTokens: p.maxTokens ?? 8192,
          },
        }),
      p.schemaName,
    );

    const raw = response.text;
    if (!raw) throw new Error(`${p.schemaName}: gemini returned no text`);

    try {
      return p.validate(JSON.parse(raw));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 2) throw new Error(`${p.schemaName}: output failed validation — ${msg}`);
      correction = `\n\nYour previous response was not valid or did not match the schema:\n${msg}\nReturn corrected JSON only.`;
    }
  }
  throw new Error("unreachable");
}
