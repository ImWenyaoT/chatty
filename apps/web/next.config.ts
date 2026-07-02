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
  // serverExternalPackages alone is not enough here: @rental/db imports
  // better-sqlite3, and because @rental/db is in transpilePackages Next follows
  // that import INTO the server bundle, where the bare-specifier external matcher
  // never fires. A bundled better-sqlite3 is fatal — its `bindings` loader locates
  // better_sqlite3.node by walking the runtime call stack (Error.prepareStackTrace
  // + CallSite.getFileName()); under webpack's eval() those frames have no file
  // name, so getFileName() returns undefined and `undefined.indexOf('file://')`
  // throws. Force the native addon to be require()'d at runtime instead of bundled.
  webpack: (webpackConfig, { isServer }) => {
    if (isServer) {
      const externalizeNativeAddon = (
        ctx: { request?: string },
        callback: (err?: Error | null, result?: string) => void,
      ) =>
        ctx.request && /^better-sqlite3(\/.*)?$/.test(ctx.request)
          ? callback(null, `commonjs ${ctx.request}`)
          : callback()
      const existing = webpackConfig.externals
      webpackConfig.externals = Array.isArray(existing)
        ? [externalizeNativeAddon, ...existing]
        : [externalizeNativeAddon, existing].filter(Boolean)
    }
    return webpackConfig
  },
}

export default config
