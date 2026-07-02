// eval 专用环境预置：必须在任何会触发 src/config 求值的 import 之前被 import。
// 原因：ESM 的 import 是提升执行的——若把 env 赋值写在 eval.ts 的模块体里（语句），
// 会晚于 import 链中 config.ts 的求值，导致 MEMORY_STORE_PATH 覆盖失效，
// eval 退回默认值 data/memory-store.json，从而误读误写生产记忆库、且测试隔离失效。
// 把赋值放进本模块、并让 eval.ts 第一条 import 就引入它，可保证其早于 config 执行。
process.env.MEMORY_STORE_PATH = process.env.MEMORY_STORE_PATH ?? 'tests/.tmp/memory-store.json'
