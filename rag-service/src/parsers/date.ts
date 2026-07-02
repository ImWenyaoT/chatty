export function normalizeDateText(raw: string) {
  return raw.replace(/[.]/g, '-').replace(/[\/]/g, '-').replace(/号/g, '').trim();
}

/**
 * 把各种可能的日期字符串统一归一化成 "YYYY-M-D" ISO-like 形式。
 * 覆盖：
 *   "5月10日" / "5月10号"  → "YYYY-5-10"（补当前年）
 *   "5/10" / "5-10"        → "YYYY-5-10"
 *   "2026-5-10"            → 原样
 *   "2026年5月10日"         → "2026-5-10"
 *   "10日" / "10号"         → "YYYY-MM-10"（补当前年月）
 * 不能识别返回 undefined。
 */
export function coerceToIsoDate(input?: string | null): string | undefined {
  if (!input) return undefined;
  const raw = String(input).trim();
  if (!raw) return undefined;

  // Case 1: 已是 YYYY-?M-?D / YYYY.M.D / YYYY/M/D
  const full = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (full) return `${full[1]}-${Number(full[2])}-${Number(full[3])}`;

  // Case 2: 2026年5月10日/号
  const fullCn = raw.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})(?:日|号)?$/);
  if (fullCn) return `${fullCn[1]}-${Number(fullCn[2])}-${Number(fullCn[3])}`;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  // Case 3: 5月10日/号（补当前年）
  const monthDay = raw.match(/^(\d{1,2})月\s*(\d{1,2})(?:日|号)?$/);
  if (monthDay) return `${year}-${Number(monthDay[1])}-${Number(monthDay[2])}`;

  // Case 4: 5/10 或 5-10（补当前年）
  const monthDaySlash = raw.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (monthDaySlash) return `${year}-${Number(monthDaySlash[1])}-${Number(monthDaySlash[2])}`;

  // Case 5: 10日/号（补当前年月）
  const dayOnly = raw.match(/^(\d{1,2})(?:日|号)$/);
  if (dayOnly) return `${year}-${month}-${Number(dayOnly[1])}`;

  return undefined;
}

/**
 * 从自由字符串里提取日期范围 "5月10日到5月12日" / "5-10~5-12" 等。
 * 先按强分隔符（到/至/~/破折号）切分，避免和 "2026-05-10" 这类
 * 连字符日期里的 "-" 冲突；强分隔符不命中时才把单个 "-" 当范围分隔符
 * （兼容 "5月10日-5月12日" 写法）。
 */
export function coerceToIsoDateRange(input?: string | null): { startDate?: string; endDate?: string } {
  if (!input) return {};
  const raw = String(input).trim();
  const strongSplit = raw.split(/\s*(?:到|至|~|—|--|\u2013|\u2014)\s*/);
  const rangeSplit = strongSplit.length === 2 ? strongSplit : raw.split(/\s*-\s*/);
  if (rangeSplit.length === 2) {
    const s = coerceToIsoDate(rangeSplit[0]);
    const e = coerceToIsoDate(rangeSplit[1]);
    if (s || e) return { startDate: s, endDate: e };
  }
  // 否则当成单日
  const single = coerceToIsoDate(raw);
  if (single) return { startDate: single, endDate: single };
  return {};
}

function padDatePart(value: number) {
  return String(value);
}

export function buildCurrentYearMonthDate(month: number, day: number) {
  const now = new Date();
  return `${now.getFullYear()}-${padDatePart(month)}-${padDatePart(day)}`;
}

export function buildCurrentMonthDate(day: number) {
  const now = new Date();
  return `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(day)}`;
}
