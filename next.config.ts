import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["@astryxdesign/core"],
  },
  // Catalog 种子与 Agent 提示词在运行时按 cwd 读取，需纳入 trace。
  outputFileTracingIncludes: {
    "/api/**": ["./data/seed/**/*", "./src/agent/**/*.md"],
    "/health": ["./data/seed/**/*", "./src/agent/**/*.md"],
  },
};

export default nextConfig;
