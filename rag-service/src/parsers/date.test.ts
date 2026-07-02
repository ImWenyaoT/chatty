// 日期归一化纯函数的单元测试：这些正则以前只靠端到端 LLM eval 兜底，
// 这里把边界行为固定下来，改坏任何一条分支都会立刻红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceToIsoDate, coerceToIsoDateRange, normalizeDateText } from './date.js';

// 测试里和被测代码用同一口径取"当前年/月"，避免跨年跑测时脆断
const now = new Date();
const YEAR = now.getFullYear();
const MONTH = now.getMonth() + 1;

test('normalizeDateText 把点、斜杠统一成横杠并去掉"号"', () => {
  assert.equal(normalizeDateText('2026.5.10'), '2026-5-10');
  assert.equal(normalizeDateText('2026/5/10'), '2026-5-10');
  assert.equal(normalizeDateText(' 10号 '), '10');
});

test('coerceToIsoDate 识别完整 ISO 及其点/斜杠变体', () => {
  assert.equal(coerceToIsoDate('2026-5-10'), '2026-5-10');
  assert.equal(coerceToIsoDate('2026-05-10'), '2026-5-10');
  assert.equal(coerceToIsoDate('2026.05.10'), '2026-5-10');
  assert.equal(coerceToIsoDate('2026/5/10'), '2026-5-10');
});

test('coerceToIsoDate 识别中文完整日期，"日/号"后缀可选', () => {
  assert.equal(coerceToIsoDate('2026年5月10日'), '2026-5-10');
  assert.equal(coerceToIsoDate('2026年 5月 10号'), '2026-5-10');
  assert.equal(coerceToIsoDate('2026年5月10'), '2026-5-10');
});

test('coerceToIsoDate 对"5月10日"补当前年', () => {
  assert.equal(coerceToIsoDate('5月10日'), `${YEAR}-5-10`);
  assert.equal(coerceToIsoDate('12月1号'), `${YEAR}-12-1`);
});

test('coerceToIsoDate 对 "5/10"、"5-10" 补当前年', () => {
  assert.equal(coerceToIsoDate('5/10'), `${YEAR}-5-10`);
  assert.equal(coerceToIsoDate('5-10'), `${YEAR}-5-10`);
});

test('coerceToIsoDate 对"10号"补当前年月', () => {
  assert.equal(coerceToIsoDate('10号'), `${YEAR}-${MONTH}-10`);
  assert.equal(coerceToIsoDate('3日'), `${YEAR}-${MONTH}-3`);
});

test('coerceToIsoDate 对不可识别输入返回 undefined', () => {
  assert.equal(coerceToIsoDate('abc'), undefined);
  assert.equal(coerceToIsoDate(''), undefined);
  assert.equal(coerceToIsoDate(null), undefined);
  assert.equal(coerceToIsoDate(undefined), undefined);
  // "181.70" 是体型数据不是日期（session 63 的真实写法），不能误吞
  assert.equal(coerceToIsoDate('181.70'), undefined);
});

test('coerceToIsoDateRange 用"到/至/~"切分范围', () => {
  assert.deepEqual(coerceToIsoDateRange('5月10日到5月12日'), {
    startDate: `${YEAR}-5-10`,
    endDate: `${YEAR}-5-12`,
  });
  assert.deepEqual(coerceToIsoDateRange('2026年5月10日 至 2026年5月12日'), {
    startDate: '2026-5-10',
    endDate: '2026-5-12',
  });
});

test('coerceToIsoDateRange 不把连字符日期里的"-"当成范围分隔符', () => {
  // 强分隔符（到/~）优先，两侧的 "5-10" 仍按日期解析
  assert.deepEqual(coerceToIsoDateRange('5-10~5-12'), {
    startDate: `${YEAR}-5-10`,
    endDate: `${YEAR}-5-12`,
  });
  assert.deepEqual(coerceToIsoDateRange('2026-05-10到2026-05-12'), {
    startDate: '2026-5-10',
    endDate: '2026-5-12',
  });
});

test('coerceToIsoDateRange 兼容用单个"-"分隔的中文日期', () => {
  assert.deepEqual(coerceToIsoDateRange('5月10日-5月12日'), {
    startDate: `${YEAR}-5-10`,
    endDate: `${YEAR}-5-12`,
  });
});

test('coerceToIsoDateRange 把单个日期视为一天的起止', () => {
  assert.deepEqual(coerceToIsoDateRange('5月10日'), {
    startDate: `${YEAR}-5-10`,
    endDate: `${YEAR}-5-10`,
  });
});

test('coerceToIsoDateRange 对无日期文本返回空对象', () => {
  assert.deepEqual(coerceToIsoDateRange('随便说点别的'), {});
  assert.deepEqual(coerceToIsoDateRange(null), {});
});
