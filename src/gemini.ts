import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry transient Gemini failures (503 overloaded, 429 rate-limit, 500) with
 * exponential backoff. A single spike shouldn't abort a whole PDF ingest.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const transient = /50\d|429|high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg);
      if (!transient || attempt === maxAttempts) throw error;
      const waitMs = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s
      console.log(`  ${label}: transient error, retrying in ${waitMs / 1000}s (${attempt}/${maxAttempts - 1})`);
      await sleep(waitMs);
    }
  }
  throw new Error("unreachable");
}

const DESCRIBE_PROMPT = `You are indexing a page from an ophthalmology course for search.

Write a dense, factual description of THIS page so a search engine can find it from
a student's question. Name the topics, anatomy, conditions, findings, and anything
labeled in figures or diagrams. Include synonyms (e.g. IOP / intraocular pressure).
No preamble, no markdown — just the description.`;

const ANSWER_PROMPT = `You are an ophthalmology teaching assistant.

Answer using only the page images provided. They are excerpts from the course
material the student is studying. Refer to what is visible — figures, labels, and
diagrams as well as body text. Be specific and concise.

If the pages do not contain the answer, say so plainly. Do not fill the gap from
memory — a student cannot tell a grounded answer from a fluent guess, and here that
difference matters.`;

/** Describe a page image so it can be embedded and searched. */
export async function describeImage(imageBase64: string): Promise<string> {
  const res = await withRetry(
    () =>
      ai.models.generateContent({
        model: config.GEMINI_GENERATE_MODEL,
        contents: [
          { text: DESCRIBE_PROMPT },
          { inlineData: { mimeType: "image/png", data: imageBase64 } },
        ],
      }),
    "describe",
  );

  const text = res.text?.trim();
  if (!text) throw new Error("Gemini returned no description for a page");
  return text;
}

/**
 * Embed a piece of text into a vector for cosine search.
 *
 * gemini-embedding-001 defaults to 3072 dims, but pgvector's HNSW index caps at
 * 2000, so we request 768 — which must match EMBED_DIM in db/schema.ts. Cosine
 * distance is scale-invariant, so truncated dims don't need manual normalizing.
 */
export async function embed(text: string): Promise<number[]> {
  const res = await withRetry(
    () =>
      ai.models.embedContent({
        model: config.GEMINI_EMBED_MODEL,
        contents: text,
        config: { outputDimensionality: 768 },
      }),
    "embed",
  );

  const values = res.embeddings?.[0]?.values;
  if (!values) throw new Error("Gemini returned no embedding");
  return values;
}

export interface AnswerPage {
  sourceTitle: string | null;
  sourceId: string;
  pageNumber: number;
  imageBase64: string;
}

/** Generate an answer from the retrieved page images. */
export async function answer(
  question: string,
  pages: AnswerPage[],
): Promise<string> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: `${ANSWER_PROMPT}\n\nStudent question: ${question}` },
  ];

  for (const page of pages) {
    const label = `${page.sourceTitle ?? page.sourceId}, page ${page.pageNumber}`;
    parts.push({ text: `--- ${label} ---` });
    parts.push({ inlineData: { mimeType: "image/png", data: page.imageBase64 } });
  }

  const res = await withRetry(
    () =>
      ai.models.generateContent({
        model: config.GEMINI_GENERATE_MODEL,
        contents: parts,
      }),
    "answer",
  );

  const text = res.text?.trim();
  if (!text) throw new Error("Gemini returned no answer");
  return text;
}
