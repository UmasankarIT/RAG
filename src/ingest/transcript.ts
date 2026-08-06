import path from "node:path";

/**
 * Transcript ingestion is built around the SHAPE of the data a real transcript
 * system produces — timestamped, speaker-attributed segments — not around any
 * particular file format. Nothing here parses VTT/SRT/PDF; a caller hands in
 * segments directly. `loadSegmentsFromJson` is a thin local-testing adapter
 * (a JSON fixture in this same segment shape) and is the ONLY format-aware
 * code in this file — swap it out or add another adapter without touching
 * `chunkSegments` or anything downstream.
 */

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
  speakerName: string;
}

export interface TranscriptChunk {
  text: string;
  startMs: number;
  endMs: number;
  speakers: string[];
}

const SEGMENTS_EXTENSIONS = new Set([".json"]);

export function isTranscriptFile(filePath: string): boolean {
  return SEGMENTS_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Local-testing adapter: a JSON array of `TranscriptSegment` objects. */
export function loadSegmentsFromJson(raw: string): TranscriptSegment[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("expected a JSON array of {text, startMs, endMs, speakerName} segments");
  }
  return parsed.map((s: unknown, i) => {
    const seg = s as Record<string, unknown>;
    if (
      typeof seg.text !== "string" ||
      typeof seg.startMs !== "number" ||
      typeof seg.endMs !== "number" ||
      typeof seg.speakerName !== "string"
    ) {
      throw new Error(`segment ${i} is missing text/startMs/endMs/speakerName`);
    }
    return { text: seg.text, startMs: seg.startMs, endMs: seg.endMs, speakerName: seg.speakerName };
  });
}

// --- Chunking: speaker-turn boundaries, bounded so chunks are neither ------
// --- too fragmented (rapid back-and-forth) nor too large (a monologue) -----

/** Below this, a speaker change alone doesn't end a chunk — keep merging small turns. */
const MIN_CHUNK_CHARS = 400;
/** Above this, force a break even mid-speaker — one monologue can span several chunks. */
const MAX_CHUNK_CHARS = 3000;

/**
 * Group segments into chunks along speaker-turn boundaries, one chunk = one
 * Mode 1 call. A chunk only breaks on a speaker change once it already has
 * enough content (so a rapid Q&A back-and-forth doesn't fragment into
 * one-sentence chunks); it always breaks before exceeding the max (so one
 * long monologue still gets split into multiple coherent chunks).
 */
export function chunkSegments(segments: TranscriptSegment[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let current: TranscriptSegment[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(toChunk(current));
    current = [];
    currentChars = 0;
  };

  for (const raw of segments) {
    for (const seg of splitOversized(raw)) {
      const text = seg.text.trim();
      if (!text) continue;

      const speakerChanged =
        current.length > 0 && current[current.length - 1]!.speakerName !== seg.speakerName;
      const wouldOverflow = currentChars + text.length > MAX_CHUNK_CHARS;

      if ((speakerChanged && currentChars >= MIN_CHUNK_CHARS) || (wouldOverflow && current.length > 0)) {
        flush();
      }

      current.push(seg);
      currentChars += text.length;
    }
  }
  flush();

  return chunks;
}

/**
 * A single segment can itself exceed MAX_CHUNK_CHARS (one uninterrupted
 * stretch of speech captured as one ASR segment) — split it on sentence
 * boundaries into pieces that fit, interpolating each piece's time range
 * proportionally from the original segment's span.
 */
function splitOversized(seg: TranscriptSegment): TranscriptSegment[] {
  const text = seg.text.trim();
  if (text.length <= MAX_CHUNK_CHARS) return [seg];

  const sentences = text.split(/(?<=[.?!])\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);

  const duration = seg.endMs - seg.startMs;
  const totalChars = pieces.reduce((sum, p) => sum + p.length, 0);
  let elapsedChars = 0;
  return pieces.map((piece) => {
    const startFraction = elapsedChars / totalChars;
    elapsedChars += piece.length;
    const endFraction = elapsedChars / totalChars;
    return {
      text: piece,
      speakerName: seg.speakerName,
      startMs: seg.startMs + Math.round(duration * startFraction),
      endMs: seg.startMs + Math.round(duration * endFraction),
    };
  });
}

function toChunk(segments: TranscriptSegment[]): TranscriptChunk {
  const speakers = [...new Set(segments.map((s) => s.speakerName))];
  return {
    text: segments.map((s) => `${s.speakerName}: ${s.text.trim()}`).join("\n"),
    startMs: Math.min(...segments.map((s) => s.startMs)),
    endMs: Math.max(...segments.map((s) => s.endMs)),
    speakers,
  };
}
