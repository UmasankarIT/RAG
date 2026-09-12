import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { requireUserId } from "@/lib/require-user";
import { deleteFile } from "@/lib/storage";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; docId: string }> },
) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id: knowledgeBaseId, docId } = await context.params;
  const [deleted] = await db
    .delete(schema.documents)
    .where(
      and(
        eq(schema.documents.id, docId),
        eq(schema.documents.knowledgeBaseId, knowledgeBaseId),
        eq(schema.documents.userId, userId),
      ),
    )
    .returning({ storageKey: schema.documents.storageKey });

  if (!deleted) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  await deleteFile(deleted.storageKey).catch(() => {});

  return NextResponse.json({ ok: true });
}
