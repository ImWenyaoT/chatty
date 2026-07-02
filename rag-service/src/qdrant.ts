import { QdrantClient } from '@qdrant/js-client-rest'
import { config } from './config.js'

export const qdrant = new QdrantClient({
  url: config.qdrantUrl,
})

export async function ensureCollection() {
  const collections = await qdrant.getCollections()
  const exists = collections.collections.some(
    (collection) => collection.name === config.qdrantCollection,
  )

  if (!exists) {
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: {
        size: config.vectorSize,
        distance: 'Cosine',
      },
    })
    return
  }

  const collection = await qdrant.getCollection(config.qdrantCollection)
  const currentVectors = collection.config?.params?.vectors
  const currentSize =
    !Array.isArray(currentVectors) && currentVectors && 'size' in currentVectors
      ? currentVectors.size
      : undefined

  if (currentSize !== config.vectorSize) {
    await qdrant.deleteCollection(config.qdrantCollection)
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: {
        size: config.vectorSize,
        distance: 'Cosine',
      },
    })
  }
}

export async function isQdrantAvailable() {
  try {
    await qdrant.getCollections()
    return true
  } catch {
    return false
  }
}
