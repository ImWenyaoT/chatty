// 显式调用的领域配置加载器。对应 legacy rag-service/src/prompts-loader.ts 的 loadAll()，
// 两处刻意差异：
//   1. 绝不在 import 期执行（legacy 的 `export const loaded = loadAll()` 是 import 期副作用，
//      eval-env.ts hack 就是为绕过它而存在的——重写在此消灭）；
//   2. configDir 由调用方显式传入，不再用 import.meta.url 猜测 dist/src 相对路径。
// YAML 结构校验逻辑与 legacy 逐条对齐（缺字段即抛错，错误信息带文件路径）。

import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { CatalogFile } from './catalog.js'
import { computePromptVersion, type PromptsFile } from './prompts.js'

/** loadDomainConfig 的返回：解析后的 prompts / catalog + 版本哈希 */
export interface DomainConfig {
  versionName: string
  promptVersion: string
  prompts: PromptsFile
  catalog: CatalogFile
}

/** 读取并解析单个 YAML 文件，同时保留原始文本（哈希计算需要） */
function readYaml<T>(filePath: string): { data: T; raw: string } {
  const raw = fs.readFileSync(filePath, 'utf8')
  return { data: YAML.parse(raw) as T, raw }
}

/**
 * 从 configDir 加载 config/prompts/<versionName>.yaml 与 config/catalog.yaml，
 * 校验必填字段后返回 { prompts, catalog, promptVersion }。
 * 纯显式调用：进程内何时加载、加载几次完全由组合根决定。
 */
export function loadDomainConfig(configDir: string, versionName = 'v1'): DomainConfig {
  const promptsPath = path.join(configDir, 'prompts', `${versionName}.yaml`)
  const catalogPath = path.join(configDir, 'catalog.yaml')

  const prompts = readYaml<PromptsFile>(promptsPath)
  const catalog = readYaml<CatalogFile>(catalogPath)

  const requiredPromptKeys: (keyof PromptsFile)[] = [
    'stylistPrompt',
    'systemSupplement',
    'evaluatorSystemPrompt',
    'evaluatorUserTemplate',
    'factExtractorSystemPrompt',
  ]
  for (const key of requiredPromptKeys) {
    if (!prompts.data?.[key]) {
      throw new Error(`[config-load] ${promptsPath} missing field: ${key}`)
    }
  }
  if (!Array.isArray(catalog.data?.products)) {
    throw new Error(`[config-load] ${catalogPath} missing products array`)
  }
  if (!Array.isArray(catalog.data?.sizeRules)) {
    throw new Error(`[config-load] ${catalogPath} missing sizeRules array`)
  }

  return {
    versionName,
    promptVersion: computePromptVersion(versionName, prompts.raw, catalog.raw),
    prompts: prompts.data,
    catalog: catalog.data,
  }
}
