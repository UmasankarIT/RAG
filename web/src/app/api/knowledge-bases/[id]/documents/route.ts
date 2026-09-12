import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { detectFileType } from "@/lib/ingest/extract";
import { processDocument } from "@/lib/ingest/pipeline";
import { requireUserId } from "@/lib/require-user";
import { uploadFile } from "@/lib/storage";

async function ownedKnowledgeBase(id: string, userId: string) {
  const [kb] = await db
    .select({ id: schema.knowledgeBases.id })
    .from(schema.knowledgeBases)
    .where(and(eq(schema.knowledgeBases.id, id), eq(schema.knowledgeBases.userId, userId)))
    .limit(1);
  return kb ?? null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!(await ownedKnowledgeBase(id, userId))) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.knowledgeBaseId, id))
    .orderBy(schema.documents.createdAt);

  return NextResponse.json({ ok: true, data: rows });
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id: knowledgeBaseId } = await context.params;
  if (!(await ownedKnowledgeBase(knowledgeBaseId, userId))) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "missing file" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ ok: false, error: "file exceeds 25 MB limit" }, { status: 413 });
  }

  let fileType: string;
  try {
    fileType = detectFileType(file.name);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const [doc] = await db
    .insert(schema.documents)
    .values({
      knowledgeBaseId,
      userId,
      fileName: file.name,
      fileType,
      storageKey: "", // filled in once we know the row's id
      status: "processing",
    })
    .returning();
  if (!doc) return NextResponse.json({ ok: false, error: "failed to create document" }, { status: 500 });

  const storageKey = `${userId}/${doc.id}/${file.name}`;
  await uploadFile(storageKey, Buffer.from(await file.arrayBuffer()), file.type || undefined);

  await db.update(schema.documents).set({ storageKey }).where(eq(schema.documents.id, doc.id));

  // Fire-and-forget: the upload response returns immediately with
  // status 'processing'; the UI polls the documents list for 'ready'/'failed'.
  void processDocument(doc.id);

  return NextResponse.json({ ok: true, data: { ...doc, storageKey } });
}
