const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

/**
 * Split text into overlapping windows, breaking on paragraph/sentence
 * boundaries where possible so a chunk doesn't cut a sentence in half. Plain
 * and dependency-free — no need for a chunking library at this scale.
 */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const flushAndStartNext = (next: string) => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = overlapTail(current) + next;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_SIZE) {
      // A single paragraph longer than the chunk size — split on sentences.
      const sentences = paragraph.split(/(?<=[.?!])\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 > CHUNK_SIZE) {
          flushAndStartNext(sentence);
        } else {
          current = current ? `${current} ${sentence}` : sentence;
        }
      }
      continue;
    }

    if (current.length + paragraph.length + 2 > CHUNK_SIZE) {
      flushAndStartNext(paragraph);
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/** The tail of the previous chunk, carried into the next one for continuity. */
function overlapTail(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return "";
  return `${text.slice(-CHUNK_OVERLAP)}\n\n`;
}
