/**
 * round-half-to-even（banker's rounding）。
 *
 * JS 的 `Math.round()` 是 round-half-up，两者在 `.5` 边界结果不同，而金额换算与
 * 相关性分数都会命中这个边界。golden 基线冻结了这些值，换成 `Math.round()`
 * 会改变对外可见的价格与排序。
 */
export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const lower = Math.floor(scaled);
  const remainder = scaled - lower;

  let rounded: number;
  if (remainder > 0.5) rounded = lower + 1;
  else if (remainder < 0.5) rounded = lower;
  else rounded = lower % 2 === 0 ? lower : lower + 1;

  return rounded / factor;
}
