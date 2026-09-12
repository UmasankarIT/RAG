import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

// A separate, edge-safe NextAuth instance (no providers, no DB, no Node APIs)
// — see auth.config.ts. It shares AUTH_SECRET with the full instance in
// auth.ts (both read it from the environment), so it can verify the same
// session JWT without ever importing the Postgres driver into Edge Runtime.
const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = ["/login", "/signup"];

export default auth((request) => {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p);
  const isAuthRoute = pathname.startsWith("/api/auth");

  if (isAuthRoute) return NextResponse.next();

  if (!request.auth && !isPublic) {
    const loginUrl = new URL("/login", request.nextUrl.origin);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (request.auth && isPublic) {
    return NextResponse.redirect(new URL("/", request.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  // Skip static assets and Next internals; guard everything else (pages + API).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
