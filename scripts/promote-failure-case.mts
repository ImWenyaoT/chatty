// 失败用例晋升 CLI：把评估闭环的最后一步真正接上（PRD §13）。
//
//   trace → review → failure_case(open) → 【本工具】 → tests/golden/*.yaml → pnpm eval
//
// 用法（先 pnpm build:skeleton）：
//   CHATTY_DB_PATH=data/chatty.db node scripts/promote-failure-case.mts --list
//   CHATTY_DB_PATH=data/chatty.db node scripts/promote-failure-case.mts <failure-case-id>
//   CHATTY_DB_PATH=data/chatty.db node scripts/promote-failure-case.mts <failure-case-id> --dismiss
//
// 晋升后的 YAML 直接落在 rag-service/tests/golden/（eval 运行器只扫平级目录），
// 文件名带 regression- 前缀以便和手写金标区分。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, createFailureCaseRepository } from '@rental/db'
import type { FailureCaseRepository } from '@rental/db'
import { exportFailureCaseToGoldenYaml } from '@rental/agent-core'

/** 晋升结果：写出的金标文件绝对路径与其内容。 */
export interface PromoteResult {
  file: string
  yaml: string
}

/**
 * 把一个 open 状态的失败用例晋升为金标回归测试：
 * 导出 YAML → 写入 goldenDir → 标记 promoted。写文件成功后才改状态，
 * 保证不会出现「状态已 promoted 但金标文件不存在」的断链。
 */
export function promoteFailureCase(
  failures: FailureCaseRepository,
  id: string,
  goldenDir: string,
): PromoteResult {
  const fc = failures.findOpen().find((c) => c.id === id)
  if (!fc) throw new Error(`找不到 open 状态的失败用例：${id}（用 --list 查看候选）`)

  const golden = exportFailureCaseToGoldenYaml({
    traceId: fc.traceId,
    sessionId: fc.sessionId,
    score: fc.score,
    issues: fc.issues,
    input: fc.input,
    output: fc.output,
  })

  fs.mkdirSync(goldenDir, { recursive: true })
  const file = path.join(goldenDir, golden.filename)
  fs.writeFileSync(file, golden.yaml, 'utf8')
  failures.markPromoted(id)
  return { file, yaml: golden.yaml }
}

/** 列出待复核（open）的失败用例，供人工分诊。 */
function listOpen(failures: FailureCaseRepository): void {
  const open = failures.findOpen()
  if (open.length === 0) {
    console.log('没有待复核的失败用例。')
    return
  }
  for (const fc of open) {
    console.log(
      `${fc.id}  score=${fc.score}  trace=${fc.traceId}  issues=${fc.issues.join('、') || '(无)'}`,
    )
  }
  console.log(
    `\n共 ${open.length} 条。晋升：node scripts/promote-failure-case.mts <id>；驳回：<id> --dismiss`,
  )
}

/** CLI 入口：解析参数并分派到 list / promote / dismiss。 */
function main(): void {
  const args = process.argv.slice(2)
  const dbPath = process.env.CHATTY_DB_PATH
  if (!dbPath) {
    console.error('请通过 CHATTY_DB_PATH 指定 SQLite 数据库文件（与 apps/web 相同的约定）。')
    process.exit(1)
  }

  const db = openDatabase(path.resolve(dbPath))
  const failures = createFailureCaseRepository(db)

  if (args.length === 0 || args.includes('--list')) {
    listOpen(failures)
    return
  }

  const id = args[0]
  if (args.includes('--dismiss')) {
    failures.markDismissed(id)
    console.log(`已驳回：${id}（status=dismissed，不再进入晋升队列）`)
    return
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const goldenDir = path.join(repoRoot, 'rag-service', 'tests', 'golden')
  const { file } = promoteFailureCase(failures, id, goldenDir)
  console.log(`已晋升：${id}`)
  console.log(`金标文件：${path.relative(repoRoot, file)}`)
  console.log('下一步：cd rag-service && pnpm eval -- --filter regression- 让回归用例真正跑起来。')
}

// 仅在直接执行时进入 CLI；被 import（如 smoke 测试）时只导出函数
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
