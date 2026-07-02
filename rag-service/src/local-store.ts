import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import type { VectorPoint } from './types.js'

function resolveStorePath() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  // In dist/ the loader sits at dist/src/, so ../data is dist/data (missing).
  // Prefer the dist-relative path; fall back to the package-root-relative path.
  const distPath = path.resolve(currentDir, '..', config.localVectorStorePath)
  if (fsSync.existsSync(distPath)) return distPath
  return path.resolve(currentDir, '..', '..', config.localVectorStorePath)
}

export async function writeLocalVectors(points: VectorPoint[]) {
  const storePath = resolveStorePath()
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.writeFile(storePath, JSON.stringify(points, null, 2), 'utf8')
}

export async function readLocalVectors(): Promise<VectorPoint[]> {
  const storePath = resolveStorePath()
  try {
    const content = await fs.readFile(storePath, 'utf8')
    return JSON.parse(content) as VectorPoint[]
  } catch {
    return []
  }
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0
  let normA = 0
  let normB = 0

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
