/**
 * Ingest a PDF into the 3H knowledge graph (Mode 1).
 *
 *   npm run ingest -- <pdf-path> --source-id glaucoma-101 [--title "Glaucoma"]
 */
import path from "node:path";
import { closeDb } from "../db/index.js";
import { ingestPdf } from "./pipeline.js";

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

  const pdfPath = positional[0];
  if (!pdfPath) {
    console.error(
      'usage: npm run ingest -- <pdf-path> --source-id <id> [--title "..."]',
    );
    process.exit(1);
  }

  const sourceKey = flags.get("source-id") ?? path.parse(pdfPath).name;
  const title = flags.get("title");

  console.log(`Ingesting ${pdfPath} as "${sourceKey}"`);
  const started = Date.now();

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
