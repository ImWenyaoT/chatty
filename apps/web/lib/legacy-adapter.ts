import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Evaluator } from '@rental/agent-core'

// Wires the legacy rag-service LLM-judge (evaluateCustomerServiceReply) into
// the new stack in-process, behind the agent-core Evaluator boundary. No
// Fastify, no HTTP — the evaluator is side-effect-free for the scoring path.
//
// Loaded lazily via dynamic import because rag-service ships its own dependency
// versions (openai ^4, zod ^3) which we do not want in the Next server graph;
// next.config.ts marks rag-service a server external.

const require = createRequire(import.meta.url)

// Candidate locations of the legacy rag-service build. __dirname is unreliable
// inside Next's bundled server chunks, so we resolve from several anchors:
//   1. process.cwd() when the server runs from the repo root
//   2. process.cwd() when the server runs from apps/web (pnpm --filter dev/start)
//   3./4. this module's source dir (works under tsx / non-bundled runtimes)
const RAG_DIST_CANDIDATES = [
  path.resolve(process.cwd(), 'rag-service/dist/src/rag.js'),
  path.resolve(process.cwd(), '../../rag-service/dist/src/rag.js'),
  path.resolve(__dirname, '../../../rag-service/dist/src/rag.js'),
  path.resolve(__dirname, '../../rag-service/dist/src/rag.js'),
]

let cachedModule: RagModule | undefined

interface RagModule {
  evaluateCustomerServiceReply: (
    history: Array<{ role: string; content: string }>,
    reply: string,
  ) => Promise<import('@rental/agent-core').EvaluationResult>
}

/**
 * Imports the legacy ESM module at runtime without making Next's bundler try to
 * statically analyze a variable import expression. The specifier still comes
 * only from RAG_DIST_CANDIDATES, so callers cannot inject arbitrary paths.
 */
async function importRuntimeModule(filePath: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ pathToFileURL(filePath).href)
}

/**
 * 在候选路径中定位 legacy rag-service 的构建产物；找不到时返回 undefined，
 * 调用方据此跳过异步评估而不是抛错。
 */
function resolveRagDist(): string | undefined {
  for (const candidate of RAG_DIST_CANDIDATES) {
    try {
      require('node:fs').accessSync(candidate)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return undefined
}

/**
 * Loads the legacy evaluator (evaluateCustomerServiceReply) wrapped behind the
 * agent-core Evaluator boundary. The imported module is cached for the process
 * so there is no second dynamic import. Returns undefined when rag-service is
 * unavailable; callers should then skip async evaluation.
 */
export async function loadLegacyEvaluator(): Promise<Evaluator | undefined> {
  try {
    if (!cachedModule) {
      const ragPath = resolveRagDist()
      if (!ragPath) return undefined
      cachedModule = (await importRuntimeModule(ragPath)) as RagModule
    }
    const mod = cachedModule
    if (!mod?.evaluateCustomerServiceReply) return undefined
    return { evaluate: (history, reply) => mod.evaluateCustomerServiceReply(history, reply) }
  } catch {
    return undefined
  }
}
