import { EMBEDDING_DIM } from "./config";

/**
 * The embedding boundary — every embed call in the app goes through here.
 * Ingestion (lib/ingest/pipeline.ts) and retrieval (lib/retrieve.ts) both only
 * know this function signature, not which model backs it.
 *
 * TEMPORARY DEFAULT: a local ONNX model (all-MiniLM-L6-v2, 384-dim) via
 * transformers.js — no API key, no GPU, runs in-process. This is a
 * placeholder to make the pipeline runnable end-to-end; swap it for a hosted
 * embedding provider later by changing only this file (and EMBEDDING_DIM in
 * config.ts to match the new model's output size).
 */

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      return extractor as unknown as FeatureExtractionPipeline;
    })();
  }
  return extractorPromise;
}

/** Embed a batch of texts. Order of the returned vectors matches `texts`. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const vectors = output.tolist();
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(`embedding model returned dim ${v.length}, expected ${EMBEDDING_DIM} (EMBEDDING_DIM)`);
    }
  }
  return vectors;
}

/** Embed a single query string. */
export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector!;
}
