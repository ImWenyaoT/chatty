/**
 * Next.js route handlers 与本地 `main.ts` 共用的 Hono 应用单例。
 * 会话存在模块内存里，所以这里只构造一次。
 */

import { createApp } from "./api.ts";

export const app = createApp();
