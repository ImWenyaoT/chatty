// eval 专用环境预置：必须在任何会触发 src/config 求值的 import 之前被 import。
// 原因：ESM 的 import 是提升执行的——若把 env 赋值写在 eval.ts 的模块体里（语句），
// 会晚于 import 链中 config.ts 的求值，导致 MEMORY_STORE_PATH 覆盖失效，
// eval 退回默认值 data/memory-store.json，从而误读误写生产记忆库、且测试隔离失效。
// 把赋值放进本模块、并让 eval.ts 第一条 import 就引入它，可保证其早于 config 执行。
process.env.MEMORY_STORE_PATH = process.env.MEMORY_STORE_PATH ?? 'tests/.tmp/memory-store.json'

/**
 * 从 argv 解析 `--target`（支持 `--target x` 与 `--target=x` 两种写法），缺省 legacy。
 * 只为在 config 求值前判定当前 lane，好挑选对应的 per-target 模型覆盖，不做全量参数解析。
 */
function readEvalTarget(argv: readonly string[]): 'legacy' | 'harness' {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value =
      arg === '--target' ? argv[i + 1] : arg?.startsWith('--target=') ? arg.slice(9) : undefined
    if (value !== undefined) return value === 'harness' ? 'harness' : 'legacy'
  }
  return 'legacy'
}

// 双 lane 模型解耦（design §5.1）：legacy 与 harness 默认共读同一 CHAT_MODEL，但 legacy 的
// answerQuestion 走强制 tool_choice（intent-classifier.ts / action-picker.ts），thinking 档模型
// （如 deepseek-v4-pro）会以 HTTP 400「Thinking mode does not support this tool_choice」拒绝，
// 令 legacy 对照 lane 崩掉——红线 4「legacy 金标 11/11 平价」这道删检索子系统的硬门就无法在同一
// eval 环境里复现。允许按 --target 分别指定 LEGACY_CHAT_MODEL / HARNESS_CHAT_MODEL：在 config
// 求值前把生效值写回 CHAT_MODEL（config.ts 与 @rental/llm 的 readLlmEnv 都读它），让 legacy 跑在
// 支持 tool_choice 的非 thinking 模型上、harness 仍用 v4-pro。未设则保持读 CHAT_MODEL，向后兼容。
// 与 MEMORY_STORE_PATH 同理，这几个 env 需经 shell 传入（早于本模块之后才 load 的 dotenv）。
const perTargetModel =
  readEvalTarget(process.argv) === 'harness'
    ? process.env.HARNESS_CHAT_MODEL
    : process.env.LEGACY_CHAT_MODEL
if (perTargetModel) process.env.CHAT_MODEL = perTargetModel
