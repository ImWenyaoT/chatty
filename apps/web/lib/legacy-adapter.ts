import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LegacyChatAnswer, LegacyChatInput } from '@rental/shared'
import { createLegacyRagServiceAdapter, type LegacyRagService } from '@rental/agent-core'
import { createEvaluator, type Evaluator } from '@rental/agent-core'

// Step 5 glue: wires the existing rag-service answerQuestion() into the Chatty
// loop in-process, behind the LegacyRagService boundary the loop expects. No
// Fastify, no HTTP — the function is already side-effect-free for the answer
// path (memory writes happen in the loop / repository, not here).
//
// Loaded lazily via dynamic import because rag-service ships its own dependency
// versions (openai ^4, zod ^3) which we do not want in the Next server graph;
// next.config.ts marks rag-service a server external.

const require = createRequire(import.meta.url)

// Candidate locations of the legacy rag-service build. __dirname is unreliable
// inside Next's bundled server chunks, so we resolve from several anchors:
//   1. process.cwd() (Next runs from the repo root in dev and `next start`)
//   2. this module's source dir (works under tsx / non-bundled runtimes)
//   3. the package.json of this app as an anchor
const RAG_DIST_CANDIDATES = [
  path.resolve(process.cwd(), 'rag-service/dist/src/rag.js'),
  path.resolve(__dirname, '../../../rag-service/dist/src/rag.js'),
  path.resolve(__dirname, '../../rag-service/dist/src/rag.js'),
]

let cached: LegacyRagService | undefined
let cachedModule: RagModule | undefined
let availabilityCache: boolean | undefined

interface RagModule {
  answerQuestion: (input: LegacyChatInput) => Promise<LegacyChatAnswer>
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

export async function loadLegacyRagService(): Promise<LegacyRagService> {
  if (cached) return cached
  const ragPath = resolveRagDist()
  if (!ragPath) {
    throw new Error(`rag-service build not found in: ${RAG_DIST_CANDIDATES.join(', ')}`)
  }
  const mod = (await importRuntimeModule(ragPath)) as RagModule
  cachedModule = mod
  cached = createLegacyRagServiceAdapter((input) => mod.answerQuestion(input))
  return cached
}

/**
 * Loads the legacy evaluator (evaluateCustomerServiceReply) wrapped behind the
 * agent-core Evaluator boundary. Reuses the already-imported rag-service module
 * so there is no second dynamic import. Returns undefined when rag-service is
 * unavailable; callers should then skip async evaluation.
 */
export async function loadLegacyEvaluator(): Promise<Evaluator | undefined> {
  try {
    if (!cachedModule) {
      await loadLegacyRagService()
    }
    const mod = cachedModule
    if (!mod?.evaluateCustomerServiceReply) return undefined
    return createEvaluator((history, reply) => mod.evaluateCustomerServiceReply(history, reply))
  } catch {
    return undefined
  }
}

/**
 * True when the legacy rag-service build is importable. Used by the route
 * handler to decide between the legacy path and the LLM-only fallback. Result
 * is cached for the process.
 */
export async function isLegacyAvailable(): Promise<boolean> {
  if (availabilityCache !== undefined) return availabilityCache
  try {
    await loadLegacyRagService()
    availabilityCache = true
  } catch (err) {
    availabilityCache = false
    console.warn(
      '[legacy-adapter] rag-service unavailable, using LLM-only fallback:',
      err instanceof Error ? err.message : err,
    )
  }
  return availabilityCache
}
