import { config } from "../config.js";

/** One page or one query, as returned by the embedding service. */
export interface Embedding {
  /** Mean-pooled, L2-normalized. Stage 1 (HNSW) searches this. */
  coarse: number[];
  /** Binary-quantized patch/token vectors: patchCount * (dim/8) bytes. */
  patches: Buffer;
  patchCount: number;
  dim: number;
}

interface WireEmbedding {
  coarse: number[];
  patches_b64: string;
  patch_count: number;
  dim: number;
}

/**
 * Pages per HTTP call. Bounded by GPU memory on the embedder, not the network.
 */
const PAGE_BATCH_SIZE = 8;

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.COLPALI_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `colpali ${path} failed: ${response.status} ${response.statusText}${
        detail ? ` — ${detail}` : ""
      }`,
    );
  }

  return (await response.json()) as T;
}

function decode(wire: WireEmbedding): Embedding {
  return {
    coarse: wire.coarse,
    patches: Buffer.from(wire.patches_b64, "base64"),
    patchCount: wire.patch_count,
    dim: wire.dim,
  };
}

/** Embed page images. Batches internally; pass the whole set. */
export async function embedPages(images: Buffer[]): Promise<Embedding[]> {
  const results: Embedding[] = [];
  for (let i = 0; i < images.length; i += PAGE_BATCH_SIZE) {
    const batch = images.slice(i, i + PAGE_BATCH_SIZE);
    const wire = await post<WireEmbedding[]>("/embed/pages", {
      images: batch.map((buf) => buf.toString("base64")),
    });
    results.push(...wire.map(decode));
  }
  return results;
}

export async function embedQuery(query: string): Promise<Embedding> {
  const wire = await post<WireEmbedding[]>("/embed/query", { queries: [query] });
  const embedding = wire[0];
  if (!embedding) throw new Error("colpali returned no embedding for query");
  return decode(embedding);
}

/** True if the embedding service is up. Lets ingest degrade gracefully. */
export async function colpaliHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${config.COLPALI_URL}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}
