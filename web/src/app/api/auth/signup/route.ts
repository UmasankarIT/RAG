import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { hashPassword } from "@/lib/password";

const signupBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(200).optional(),
});

/** Bare-bones email shape check — deliberately not `.email()` (avoids pinning
 * behavior to a specific zod version's string-format implementation). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const parsed = signupBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid input" }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: "invalid email" }, { status: 400 });
  }

  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing) {
    return NextResponse.json({ ok: false, error: "an account with that email already exists" }, { status: 409 });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const [user] = await db
    .insert(schema.users)
    .values({ email, passwordHash, name: parsed.data.name ?? null })
    .returning({ id: schema.users.id, email: schema.users.email });

  return NextResponse.json({ ok: true, data: user });
}
