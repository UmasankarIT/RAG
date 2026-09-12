import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { requireUserId } from "@/lib/require-user";
import { deleteFiles } from "@/lib/storage";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;

  // Read the storage keys before the cascade deletes the document rows.
  const docs = await db
    .select({ storageKey: schema.documents.storageKey })
    .from(schema.documents)
    .where(eq(schema.documents.knowledgeBaseId, id));

  const [deleted] = await db
    .delete(schema.knowledgeBases)
    .where(and(eq(schema.knowledgeBases.id, id), eq(schema.knowledgeBases.userId, userId)))
    .returning({ id: schema.knowledgeBases.id });

  if (!deleted) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  await deleteFiles(docs.map((d) => d.storageKey)).catch(() => {});

  return NextResponse.json({ ok: true });
}
