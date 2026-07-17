import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pdf } from "pdf-to-img";

export interface RasterizedPage {
  pageNumber: number;
  imagePath: string;
  imageBase64: string;
}

/**
 * Turn a PDF into one PNG per page. No GPU, no text extraction — just pictures.
 */
export async function rasterize(
  pdfPath: string,
  sourceId: string,
  outDir: string,
): Promise<RasterizedPage[]> {
  const dir = join(outDir, sourceId);
  await mkdir(dir, { recursive: true });

  const document = await pdf(pdfPath, { scale: 2 });

  const pages: RasterizedPage[] = [];
  let pageNumber = 0;

  for await (const image of document) {
    pageNumber += 1;
    const imagePath = join(dir, `page-${String(pageNumber).padStart(4, "0")}.png`);
    await writeFile(imagePath, image);
    pages.push({
      pageNumber,
      imagePath,
      imageBase64: image.toString("base64"),
    });
  }

  return pages;
}
