import 'dotenv/config';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkText } from '../src/chunking.js';
import { config } from '../src/config.js';
import { writeLocalVectors } from '../src/local-store.js';
import { embedText } from '../src/rag.js';
import { ensureCollection, isQdrantAvailable, qdrant } from '../src/qdrant.js';

const DOCS_DIR = path.resolve(process.cwd(), 'docs');

function toPointId(value: string) {
  const hash = createHash('md5').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(fullPath);
      if (/\.(md|txt|json|csv)$/i.test(entry.name)) return [fullPath];
      return [];
    }),
  );

  return files.flat();
}

async function main() {
  const files = await walk(DOCS_DIR);
  const points = [] as Array<{
    id: string;
    vector: number[];
    payload: {
      id: string;
      text: string;
      sourceType: 'rule' | 'history' | 'product';
      contentType: 'qa' | 'text' | 'image';
      filePath: string;
      title: string;
      chunkIndex: number;
    };
  }>;

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf8');
    const chunks = chunkText(filePath, content);

    for (const chunk of chunks) {
      const vector = await embedText(chunk.text);
      points.push({
        id: toPointId(chunk.id),
        vector,
        payload: {
          id: chunk.id,
          text: chunk.text,
          sourceType: chunk.sourceType,
          contentType: chunk.contentType,
          filePath: chunk.filePath,
          title: chunk.title,
          chunkIndex: chunk.chunkIndex,
        },
      });
    }
  }

  if (points.length === 0) {
    console.log('No documents found to ingest.');
    return;
  }

  if (await isQdrantAvailable()) {
    await ensureCollection();
    await qdrant.upsert(config.qdrantCollection, {
      wait: true,
      points,
    });

    console.log(`Ingested ${points.length} chunks into ${config.qdrantCollection}.`);
    return;
  }

  await writeLocalVectors(points);
  console.log(`Qdrant unavailable, wrote ${points.length} chunks to local vector store.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
