import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Slide decks (PPTX/PPT) aren't a variant of PDF — nothing is "drawn" yet,
 * just shapes/text/layout XML in a zip. Rather than reimplement a slide
 * renderer, we shell out to a real one (headless LibreOffice) to flatten each
 * slide into a PDF page, then hand that PDF to the existing ingest pipeline
 * unchanged (rasterize -> structure -> knowledge graph).
 */
const OFFICE_EXTENSIONS = [".pptx", ".ppt"];

const CANDIDATE_BINARIES = [
  process.env.LIBREOFFICE_PATH,
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  "/usr/bin/soffice",
  "/usr/local/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
].filter((p): p is string => Boolean(p));

function findSofficeBinary(): string {
  for (const candidate of CANDIDATE_BINARIES) {
    if (existsSync(candidate)) return candidate;
  }
  return "soffice"; // last resort: rely on PATH
}

export function isOfficeDocument(filePath: string): boolean {
  return OFFICE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * Convert a PPTX/PPT to PDF via headless LibreOffice, one slide per PDF page.
 * Writes to a throwaway temp directory (not next to the source file).
 */
export async function convertToPdf(inputPath: string): Promise<string> {
  const binary = findSofficeBinary();
  const outDir = await mkdtemp(path.join(tmpdir(), "3h-office-"));

  try {
    await execFileAsync(
      binary,
      ["--headless", "--convert-to", "pdf", "--outdir", outDir, inputPath],
      { timeout: 120_000 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(msg)) {
      throw new Error(
        `LibreOffice not found (tried "${binary}"). Install it, or set LIBREOFFICE_PATH to the soffice binary.`,
      );
    }
    throw new Error(`LibreOffice conversion failed: ${msg}`);
  }

  const expectedName = `${path.parse(inputPath).name}.pdf`.toLowerCase();
  const produced = (await readdir(outDir)).find((f) => f.toLowerCase() === expectedName);
  if (!produced) {
    throw new Error(`LibreOffice did not produce a PDF for "${inputPath}" in ${outDir}`);
  }
  return path.join(outDir, produced);
}
