import type { NextConfig } from 'next'

const config: NextConfig = {
  // Transpile the internal workspace packages so their emitted TS (src/ imports)
  // works under Next's bundler without a pre-build step.
  transpilePackages: [
    '@rental/shared',
    '@rental/db',
    '@rental/agent-core',
    '@rental/llm',
  ],
  // Native + cross-toolchain modules must stay external to the bundler.
  // - better-sqlite3: native addon.
  // - rental-rag-service (loaded via dynamic import from its dist): ships its own
  //   openai ^4 / zod ^3 which must not be merged into the Next server graph.
  serverExternalPackages: ['better-sqlite3', 'rental-rag-service'],
}

export default config
