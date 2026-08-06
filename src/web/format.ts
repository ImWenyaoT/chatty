/** 分转元，保留两位。价格来自 SQLite 的 `price_cents`，展示层只做格式化。 */
export const yuan = (cents: number) => (cents / 100).toFixed(2);
