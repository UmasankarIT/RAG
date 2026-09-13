import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    // Next.js caps request bodies passing through middleware at 10MB by
    // default — smaller than the 25MB upload limit enforced in
    // app/api/knowledge-bases/[id]/documents/route.ts, so a real upload in
    // that gap between 10-25MB was silently truncated and rejected before
    // our own check ever ran. Raised to match.
    proxyClientMaxBodySize: "26mb",
  },
};

export default nextConfig;
