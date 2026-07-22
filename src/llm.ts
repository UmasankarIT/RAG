import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

/**
 * The single Claude boundary. Every model call in the system goes through here:
 * Mode 1 structuring, the mode router, and answer generation. Swapping models
 * or providers is a change to this file, not to the modes.
 */
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry transient Claude failures (429 rate-limit, 5xx, overloaded) with
 * exponential backoff. A single spike shouldn't abort a whole ingest.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const status =
        error instanceof Anthropic.APIError ? error.status : undefined;
      const transient =
        status === 429 || status === 408 || (status !== undefined && status >= 500);
      if (!transient || attempt === maxAttempts) throw error;
      const waitMs = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s
      console.log(
        `  ${label}: transient error (${status}), retrying in ${waitMs / 1000}s (${attempt}/${maxAttempts - 1})`,
      );
      await sleep(waitMs);
    }
  }
  throw new Error("unreachable");
}

export type ImageMediaType = "image/png" | "image/jpeg";

export interface StructureFromImageParams<T> {
  /** System prompt — the mode's role and output contract. */
  system: string;
  /** The instruction that accompanies the image. */
  text: string;
  /** Base64-encoded page image. */
  imageBase64: string;
  imageMediaType?: ImageMediaType;
  /** A forced tool whose input IS the structured output. */
  tool: Anthropic.Tool;
  /** Validate + narrow the tool input. Throw to reject (triggers one retry). */
  validate: (input: unknown) => T;
  maxTokens?: number;
}

/**
 * Send a page image to Claude and get back a validated structured object.
 *
 * We force a single tool call so the response is always structured (R0.3), then
 * validate it against the caller's schema. If validation fails, we hand the
 * error back to the model once and let it correct itself before giving up.
 */
export async function structureFromImage<T>(
  params: StructureFromImageParams<T>,
): Promise<T> {
  const media = params.imageMediaType ?? "image/png";
  let correction = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await withRetry(
      () =>
        client.messages.create({
          model: config.ANTHROPIC_MODEL,
          max_tokens: params.maxTokens ?? 8192,
          system: params.system,
          tools: [params.tool],
          tool_choice: { type: "tool", name: params.tool.name },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: params.text + correction },
                {
                  type: "image",
                  source: { type: "base64", media_type: media, data: params.imageBase64 },
                },
              ],
            },
          ],
        }),
      params.tool.name,
    );

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error(`${params.tool.name}: model returned no tool call`);
    }

    try {
      return params.validate(block.input);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 2) {
        throw new Error(`${params.tool.name}: output failed validation — ${msg}`);
      }
      correction = `\n\nYour previous tool call did not match the required schema:\n${msg}\nReturn the tool call again, corrected.`;
    }
  }

  throw new Error("unreachable");
}
