import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { embedTexts } from "../embeddings";
import { downloadFile } from "../storage";
import { chunkText } from "./chunk";
import { extractText } from "./extract";

/**
 * Runs after a document's bytes are already saved to disk and its row
 * inserted with status 'processing'. Extracts text, chunks it, embeds every
 * chunk, and writes the chunks — or marks the document 'failed' with the
 * error message, so the upload UI can show why.
 */
export async function processDocument(documentId: string): Promise<void> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
  if (!doc) return;

  try {
    const buffer = await downloadFile(doc.storageKey);

    const text = await extractText(buffer, doc.fileType);
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error("no extractable text found in this document");
    }

    const embeddings = await embedTexts(chunks);

    await db.transaction(async (tx) => {
      await tx.delete(schema.documentChunks).where(eq(schema.documentChunks.documentId, documentId));
      await tx.insert(schema.documentChunks).values(
        chunks.map((content, i) => ({
          documentId,
          knowledgeBaseId: doc.knowledgeBaseId,
          chunkIndex: i,
          content,
          embedding: embeddings[i],
        })),
      );
      await tx.update(schema.documents).set({ status: "ready", errorMessage: null }).where(eq(schema.documents.id, documentId));
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(schema.documents).set({ status: "failed", errorMessage: message }).where(eq(schema.documents.id, documentId));
  }
}
