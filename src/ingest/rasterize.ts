import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pdf } from "pdf-to-img";

export interface RasterizedPage {
  pageNumber: number;
  /** Portable key under PAGE_IMAGE_DIR, e.g. "glaucoma-101/page-0001.png". */
  imageKey: string;
  imageBase64: string;
}

/**
 * Turn a PDF into one PNG per page, streamed. Yields a page at a time so the
 * whole document never has to sit in memory — the pipeline embeds/structures
 * each page as it arrives.
 */
export async function* rasterizePages(
  pdfPath: string,
  sourceKey: string,
  outDir: string,
): AsyncGenerator<RasterizedPage> {
  const dir = join(outDir, sourceKey);
  await mkdir(dir, { recursive: true });

  const document = await pdf(pdfPath, { scale: 2 });

  let pageNumber = 0;
  for await (const image of document) {
    pageNumber += 1;
    const fileName = `page-${String(pageNumber).padStart(4, "0")}.png`;
    await writeFile(join(dir, fileName), image);
    yield {
      pageNumber,
      imageKey: `${sourceKey}/${fileName}`,
      imageBase64: image.toString("base64"),
    };
  }
}
