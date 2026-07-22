/**
 * Late-interaction (MaxSim) scoring over binary-quantized vectors.
 *
 * Each query token is matched against its single best-matching page patch, and
 * those best matches are summed. That is what makes ColPali good at dense
 * pages: a query token can lock onto one figure label without being averaged
 * away by the other thousand patches.
 *
 * Vectors are sign-quantized to one bit per dimension, so for a,b in {-1,+1}^d
 *
 *     dot(a, b) = d - 2 * hamming(a, b)
 *
 * which makes scoring XOR + popcount instead of float dot products. For 100
 * candidate pages this is single-digit milliseconds — it runs in-process
 * rather than crossing a network boundary.
 */

/** Hamming weight of a 32-bit word. */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

/**
 * Reinterpret packed bits as 32-bit words.
 *
 * Copies rather than viewing the Buffer's ArrayBuffer directly: Node pools
 * small Buffers at arbitrary byte offsets, so a Uint32Array view can throw on
 * unaligned starts. Both sides pack identically, so word order is irrelevant.
 */
export function toWords(buffer: Buffer): Uint32Array {
  if (buffer.length % 4 !== 0) {
    throw new Error(
      `packed vectors must be a multiple of 4 bytes, got ${buffer.length}`,
    );
  }
  const words = new Uint32Array(buffer.length >>> 2);
  for (let i = 0; i < words.length; i++) {
    words[i] = buffer.readUInt32LE(i << 2);
  }
  return words;
}

/**
 * Score one page against one query.
 *
 * @param query packed query token vectors, queryCount * (dim/8) bytes
 * @param page  packed page patch vectors,  pageCount  * (dim/8) bytes
 * @returns summed best-match similarity; higher is better
 */
export function maxSim(
  query: Uint32Array,
  queryCount: number,
  page: Uint32Array,
  pageCount: number,
  dim: number,
): number {
  const wordsPerVector = dim >>> 5;
  if (wordsPerVector === 0) {
    throw new Error(`dim must be a multiple of 32, got ${dim}`);
  }
  if (query.length !== queryCount * wordsPerVector) {
    throw new Error(
      `query has ${query.length} words, expected ${queryCount * wordsPerVector}`,
    );
  }
  if (page.length !== pageCount * wordsPerVector) {
    throw new Error(
      `page has ${page.length} words, expected ${pageCount * wordsPerVector}`,
    );
  }

  let total = 0;
  for (let q = 0; q < queryCount; q++) {
    const qOffset = q * wordsPerVector;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let p = 0; p < pageCount; p++) {
      const pOffset = p * wordsPerVector;
      let distance = 0;
      for (let w = 0; w < wordsPerVector; w++) {
        distance += popcount32(query[qOffset + w]! ^ page[pOffset + w]!);
      }
      if (distance < bestDistance) bestDistance = distance;
    }

    total += dim - 2 * bestDistance;
  }
  return total;
}
