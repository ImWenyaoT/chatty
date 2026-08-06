import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 这三处按目录约定在运行时 readdir，源文件必须进产物，否则线上读不到。
   * 模块本身由 `import(\`../tools/${name}.ts\`)` 的静态前缀被打包器枚举打包，
   * 这里带的是 readdir 需要看到的那份文件列表，以及 SQLite 的种子数据。
   */
  outputFileTracingIncludes: {
    "/api/**": ["./data/seed/**", "./agent/tools/**", "./agent/hooks/**"],
  },
};

export default nextConfig;
