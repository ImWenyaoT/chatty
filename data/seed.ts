/**
 * 演示业务数据的种子。
 *
 * 这些 JSON / JSONL 只负责初始化 SQLite，不是运行时业务查询接口。
 * 路径由这个包自己解析，使用方 import 它而不是拼相对路径。
 */

import { join } from "node:path";

/** 目录路径不能写成 `new URL(dir, import.meta.url)`——打包器会当模块引用解析。 */
export const DATA_DIR = join(process.cwd(), "data/seed");
