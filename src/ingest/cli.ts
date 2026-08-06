/**
 * Ingest a PDF (or PPTX/PPT slide deck) into the 3H knowledge graph (Mode 1).
 * Slide decks are converted to PDF first (one slide per page) via headless
 * LibreOffice, then handed to the same pipeline as a PDF.
 *
 * A .json file is ingested as a live-session transcript instead — a JSON
 * array of {text, startMs, endMs, speakerName} segments, the same shape a
 * real transcript system would hand over (no VTT/SRT/PDF parsing here; that's
 * a local-testing stand-in for a future real source, not the target format).
 *
 *   npm run ingest -- <pdf-or-pptx-path> --source-id glaucoma-101 [--title "Glaucoma"]
 *   npm run ingest -- <segments.json> --source-id session-2026-08-05 [--title "..."]
 *   npm run ingest -- --delete glaucoma-101
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { closeDb } from "../db/index.js";
import { convertToPdf, isOfficeDocument } from "./officeConvert.js";
import { deleteSource, ingestPdf, ingestTranscript } from "./pipeline.js";
import { isTranscriptFile, loadSegmentsFromJson } from "./transcript.js";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${key} needs a value`);
      }
      flags.set(key, value);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  const deleteKey = flags.get("delete");
  if (deleteKey) {
    const deleted = await deleteSource(deleteKey);
    console.log(
      deleted
        ? `Deleted source "${deleteKey}" (pages, knowledge nodes, objectives, seeds).`
        : `No source found with key "${deleteKey}".`,
    );
    return;
  }

  const inputPath = positional[0];
  if (!inputPath) {
    console.error(
      'usage: npm run ingest -- <pdf-or-pptx-path> --source-id <id> [--title "..."]\n' +
        '   or: npm run ingest -- <segments.json> --source-id <id> [--title "..."]\n' +
        "   or: npm run ingest -- --delete <source-id>",
    );
    process.exit(1);
  }

  const sourceKey = flags.get("source-id") ?? path.parse(inputPath).name;
  const title = flags.get("title");

  console.log(`Ingesting ${inputPath} as "${sourceKey}"`);
  const started = Date.now();

  if (isTranscriptFile(inputPath)) {
    const raw = await readFile(inputPath, "utf-8");
    const segments = loadSegmentsFromJson(raw);
    const result = await ingestTranscript(segments, {
      sourceKey,
      ...(title !== undefined ? { title } : {}),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `\nDone in ${seconds}s: ${result.pages} chunks -> ${result.nodes} nodes, ${result.objectives} objectives, ${result.seeds} seeds, ${result.gaps} gaps.`,
    );
    return;
  }

  let pdfPath = inputPath;
  if (isOfficeDocument(inputPath)) {
    console.log(`Converting ${inputPath} to PDF (LibreOffice, one slide per page)...`);
    pdfPath = await convertToPdf(inputPath);
  }

  const result = await ingestPdf(pdfPath, {
    sourceKey,
    ...(title !== undefined ? { title } : {}),
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone in ${seconds}s: ${result.pages} pages -> ${result.nodes} nodes, ${result.objectives} objectives, ${result.seeds} seeds, ${result.gaps} gaps.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("\ningest failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
