import type { NextConfig } from "next";
import path from "path";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  turbopack: {
    root: path.join(__dirname),
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
