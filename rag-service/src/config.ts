import 'dotenv/config';

if (!process.env.MIMO_API_KEY && !process.env.OPENAI_API_KEY) {
  console.warn('[config] Missing environment variable: MIMO_API_KEY or OPENAI_API_KEY');
}

export const config = {
  openAiApiKey: process.env.MIMO_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  openAiBaseUrl: process.env.MIMO_BASE_URL ?? process.env.OPENAI_BASE_URL,
  chatModel: process.env.MIMO_MODEL ?? 'mimo-2.5',
  // generateText 专用的生成模型。不设则退回 MIMO_MODEL。
  // 推荐用指令遵循更好的模型专门跑客服回复生成，其他链路（事实抽取、评估）不受影响。
  generationModel: process.env.MIMO_MODEL_FOR_GENERATION ?? process.env.MIMO_MODEL ?? 'mimo-2.5',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  qdrantUrl: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
  qdrantCollection: process.env.QDRANT_COLLECTION ?? 'rental_knowledge',
  localVectorStorePath: process.env.LOCAL_VECTOR_STORE_PATH ?? 'data/local-vectors.json',
  memoryStorePath: process.env.MEMORY_STORE_PATH ?? 'data/memory-store.json',
  port: Number(process.env.PORT ?? 3001),
  topK: Number(process.env.TOP_K ?? 5),
  evaluatorModel: process.env.MIMO_EVALUATOR_MODEL ?? process.env.MIMO_MODEL ?? 'mimo-2.5',
  promptVersionName: process.env.PROMPT_VERSION ?? 'v1',
  enableReplyPolish: process.env.ENABLE_REPLY_POLISH === 'true',
  vectorSize: Number(process.env.VECTOR_SIZE ?? (process.env.EMBEDDING_MODEL === 'text-embedding-3-large' ? 3072 : 1536)),
};
