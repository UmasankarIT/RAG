import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe subset of the NextAuth config — used directly by middleware.ts,
 * which runs on the Edge runtime and can't load Node-only code (the Postgres
 * driver, `dotenv`'s `process.cwd()` call in config.ts, bcrypt). No
 * providers here: middleware only needs to verify an existing session JWT,
 * never to run a provider's `authorize()`. The full config in auth.ts spreads
 * this and adds the real Credentials provider for actual sign-in, which only
 * ever runs in the Node runtime (route handlers).
 */
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
};
