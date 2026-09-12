import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { requireUserId } from "@/lib/require-user";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.userId, userId))
    .orderBy(desc(schema.chatSessions.updatedAt));

  return NextResponse.json({ ok: true, data: rows });
}

const createBody = z.object({
  knowledgeBaseScope: z.enum(schema.KB_SCOPES).default("all"),
  /** Required (and must be owned by this user) only when scope is "selected". */
  knowledgeBaseIds: z.array(z.string().uuid()).optional(),
});

export async function POST(request: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const parsed = createBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid input" }, { status: 400 });
  const { knowledgeBaseScope } = parsed.data;
  const requestedIds = [...new Set(parsed.data.knowledgeBaseIds ?? [])];

  if (knowledgeBaseScope === "selected") {
    if (requestedIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "knowledgeBaseIds is required and non-empty when scope is 'selected'" },
        { status: 400 },
      );
    }
    const owned = await db
      .select({ id: schema.knowledgeBases.id })
      .from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.userId, userId), inArray(schema.knowledgeBases.id, requestedIds)));
    if (owned.length !== requestedIds.length) {
      return NextResponse.json({ ok: false, error: "one or more knowledge bases were not found" }, { status: 400 });
    }
  }

  const session = await db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.chatSessions).values({ userId, knowledgeBaseScope }).returning();
    if (knowledgeBaseScope === "selected") {
      await tx
        .insert(schema.chatSessionKnowledgeBases)
        .values(requestedIds.map((knowledgeBaseId) => ({ chatSessionId: row!.id, knowledgeBaseId })));
    }
    return row!;
  });

  return NextResponse.json({ ok: true, data: { ...session, knowledgeBaseIds: requestedIds } });
}
