import { closeDb } from "../db/index.js";
import { ingest } from "./pipeline.js";

/**
 * Usage:
 *   npm run ingest -- path/to/book.pdf --source-id glaucoma-101 --title "Glaucoma"
 */
function parseArgs(argv: string[]): {
  pdfPath: string;
  sourceId: string;
  title?: string;
} {
  const [pdfPath, ...rest] = argv;
  if (!pdfPath) {
    throw new Error(
      'Usage: npm run ingest -- <file.pdf> --source-id <id> [--title "..."]',
    );
  }

  let sourceId: string | undefined;
  let title: string | undefined;

  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!value) break;
    if (flag === "--source-id") sourceId = value;
    else if (flag === "--title") title = value;
  }

  if (!sourceId) throw new Error("--source-id is required");

  return title === undefined ? { pdfPath, sourceId } : { pdfPath, sourceId, title };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Ingesting ${options.pdfPath} as "${options.sourceId}"`);
  const n = await ingest(options);
  console.log(`Done: ${n} pages indexed.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
