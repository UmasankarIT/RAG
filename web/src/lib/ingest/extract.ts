import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/** Supported file types, matched against the upload's extension. */
export function detectFileType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (["pdf", "docx", "txt", "md", "markdown"].includes(ext)) {
    return ext === "markdown" ? "md" : ext;
  }
  throw new Error(`unsupported file type ".${ext}" — supported: pdf, docx, txt, md`);
}

/** Extract plain text from an uploaded file's bytes, by type. */
export async function extractText(buffer: Buffer, fileType: string): Promise<string> {
  switch (fileType) {
    case "pdf": {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    }
    case "docx": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case "txt":
    case "md":
      return buffer.toString("utf-8");
    default:
      throw new Error(`unsupported file type "${fileType}"`);
  }
}
