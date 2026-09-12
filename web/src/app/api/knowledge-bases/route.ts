import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { requireUserId } from "@/lib/require-user";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(schema.knowledgeBases)
    .where(eq(schema.knowledgeBases.userId, userId))
    .orderBy(desc(schema.knowledgeBases.createdAt));

  return NextResponse.json({ ok: true, data: rows });
}

const createBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

export async function POST(request: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const parsed = createBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid input" }, { status: 400 });

  const [kb] = await db
    .insert(schema.knowledgeBases)
    .values({ userId, name: parsed.data.name, description: parsed.data.description ?? null })
    .returning();

  return NextResponse.json({ ok: true, data: kb });
}
