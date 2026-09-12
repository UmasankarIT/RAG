import { auth } from "./auth";

/** Every API route is already gated by middleware.ts, so a missing session
 * here means something's wrong with the request rather than a normal
 * "logged out" case — still handled cleanly rather than assumed impossible. */
export async function requireUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
