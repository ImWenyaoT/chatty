/**
 * 演示业务数据的种子。
 *
 * 这些 JSON / JSONL 只负责初始化 SQLite，不是运行时业务查询接口。
 * 路径由这个包自己解析，使用方 import 它而不是拼相对路径。
 *
 * 用 `process.cwd()` 字符串路径，避免 Next.js 打包后 webpack URL 与
 * Node `fileURLToPath` 的 URL 类不一致。
 */

import { join } from "node:path";

/** 仓库根 `data/seed/`；种子不属于 `src/` 运行时布局。 */
export const DATA_DIR = join(process.cwd(), "data", "seed");
