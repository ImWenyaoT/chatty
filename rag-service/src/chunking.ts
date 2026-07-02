import path from 'node:path'
import type { KnowledgeChunk, SourceType } from './types.js'

const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 80

function parseCsvLine(line: string) {
  const values: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const nextChar = line[index + 1]

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  values.push(current.trim())
  return values
}

function chunkQaCsv(filePath: string, content: string, sourceType: SourceType, title: string) {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return [] as KnowledgeChunk[]
  }

  const header = parseCsvLine(lines[0]).map((item) => item.toLowerCase())
  if (header.length !== 2 || header[0] !== 'question' || header[1] !== 'answer') {
    throw new Error(`Invalid QA CSV header in ${filePath}. Expected: question,answer`)
  }

  return lines.slice(1).map((line, index) => {
    const columns = parseCsvLine(line)
    if (columns.length !== 2) {
      throw new Error(
        `Invalid QA CSV row in ${filePath} at line ${index + 2}. Expected exactly 2 columns.`,
      )
    }

    const question = columns[0].trim()
    const answer = columns[1].trim()
    if (!question || !answer) {
      throw new Error(
        `Invalid QA CSV row in ${filePath} at line ${index + 2}. Question and answer cannot be empty.`,
      )
    }

    return {
      id: `${title}-${index}`,
      text: `Q: ${question}\nA: ${answer}`,
      sourceType,
      contentType: 'qa' as const,
      filePath,
      title,
      chunkIndex: index,
    }
  })
}

export function inferSourceType(filePath: string): SourceType {
  if (filePath.includes(`${path.sep}rules${path.sep}`)) return 'rule'
  if (filePath.includes(`${path.sep}history${path.sep}`)) return 'history'
  return 'product'
}

export function chunkText(filePath: string, content: string): KnowledgeChunk[] {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  const sourceType = inferSourceType(filePath)
  const title = path.basename(filePath)

  if (path.extname(filePath).toLowerCase() === '.csv') {
    return chunkQaCsv(filePath, normalized, sourceType, title)
  }

  const chunks: KnowledgeChunk[] = []

  let start = 0
  let chunkIndex = 0

  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length)
    const text = normalized.slice(start, end).trim()

    if (text) {
      chunks.push({
        id: `${title}-${chunkIndex}`,
        text,
        sourceType,
        contentType: 'text',
        filePath,
        title,
        chunkIndex,
      })
    }

    if (end === normalized.length) break
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
    chunkIndex += 1
  }

  return chunks
}
