// @rental/domain 公共出口。基础层（RW-1 第一波）：类型、解析器、目录/尺码规则、
// prompt 版本计算、显式配置加载、编排状态机、模板与生成规格、文本清洗。
// 后续波次将补齐 ports / extraction / routing / generation / engine（见 docs/architecture.md §3）。
export * from './types.js'
export * from './parsers/date.js'
export * from './parsers/measurements.js'
export * from './catalog.js'
export * from './prompts.js'
export * from './config-load.js'
export * from './orchestrator.js'
export * from './templates.js'
export * from './action-specs.js'
export * from './sanitize.js'
