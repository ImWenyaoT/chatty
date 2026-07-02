import 'dotenv/config';

const required = ['OPENAI_API_KEY'] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.warn(`[config] Missing environment variable: ${key}`);
  }
}

export const config = {
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiBaseUrl: process.env.OPENAI_BASE_URL,
  chatModel: process.env.CHAT_MODEL ?? 'gpt-5.2',
  // generateText 专用的生成模型。不设则退回 CHAT_MODEL。
  // 推荐用指令遵循更好的模型（如 gpt-4o / claude-sonnet）专门跑客服回复生成，其他链路（事实抽取、评估）不受影响。
  generationModel: process.env.CHAT_MODEL_FOR_GENERATION ?? process.env.CHAT_MODEL ?? 'gpt-5.2',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  qdrantUrl: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
  qdrantCollection: process.env.QDRANT_COLLECTION ?? 'rental_knowledge',
  localVectorStorePath: process.env.LOCAL_VECTOR_STORE_PATH ?? 'data/local-vectors.json',
  memoryStorePath: process.env.MEMORY_STORE_PATH ?? 'data/memory-store.json',
  port: Number(process.env.PORT ?? 3001),
  topK: Number(process.env.TOP_K ?? 5),
  evaluatorModel: process.env.EVALUATOR_MODEL ?? process.env.EVALUATION_MODEL ?? 'gpt-5.2',
  promptVersionName: process.env.PROMPT_VERSION ?? 'v1',
  vectorSize: Number(process.env.VECTOR_SIZE ?? (process.env.EMBEDDING_MODEL === 'text-embedding-3-large' ? 3072 : 1536)),
};
