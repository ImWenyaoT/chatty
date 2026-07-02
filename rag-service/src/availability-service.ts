import type { AvailabilityQueryInput, AvailabilityQueryResult } from './types.js'

// 库存/档期查询的占位实现：真实库存系统的接入接缝。
// 状态机的「库存核验」stage 和 memory-store 的 inferAvailabilityCheck 依赖此接口的
// 返回形状；接真实库存后端时只需替换本函数，调用方不感知。当前恒返回可租。
export async function queryAvailability(
  _input: AvailabilityQueryInput,
): Promise<AvailabilityQueryResult> {
  return {
    available: true,
    availableSize: 'L',
    checkedAt: new Date().toISOString(),
    source: 'api',
  }
}
