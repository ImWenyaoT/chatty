/**
 * Python 的 `round()` 采用 banker's rounding（round-half-to-even），JS 的
 * `Math.round()` 是 round-half-up。两者在 `.5` 边界上结果不同，而金额换算与相关性
 * 分数都会命中这个边界，所以这里显式实现 Python 语义。
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
