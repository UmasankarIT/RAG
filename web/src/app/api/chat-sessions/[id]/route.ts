import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { requireUserId } from "@/lib/require-user";
import { resolveSessionKnowledgeBases } from "@/lib/session-knowledge-bases";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const [session] = await db
    .select()
    .from(schema.chatSessions)
    .where(and(eq(schema.chatSessions.id, id), eq(schema.chatSessions.userId, userId)))
    .limit(1);
  if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  const [messages, knowledgeBases] = await Promise.all([
    db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.chatSessionId, id))
      .orderBy(asc(schema.chatMessages.createdAt)),
    resolveSessionKnowledgeBases(session),
  ]);

  return NextResponse.json({ ok: true, data: { session: { ...session, knowledgeBases }, messages } });
}

const patchBody = z.object({ title: z.string().min(1).max(200) });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const parsed = patchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid input" }, { status: 400 });

  const [updated] = await db
    .update(schema.chatSessions)
    .set({ title: parsed.data.title })
    .where(and(eq(schema.chatSessions.id, id), eq(schema.chatSessions.userId, userId)))
    .returning();

  if (!updated) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, data: updated });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const [deleted] = await db
    .delete(schema.chatSessions)
    .where(and(eq(schema.chatSessions.id, id), eq(schema.chatSessions.userId, userId)))
    .returning({ id: schema.chatSessions.id });

  if (!deleted) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
