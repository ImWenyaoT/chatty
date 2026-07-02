// 身高/体重/件数抽取纯函数的单元测试。
// 用例大量来自真实会话观察（legacy rag-service 真实会话观察记录）：斤/公斤混用、
// "179, 157斤"、"181.70公斤"（用户用句号拼的 181cm+70kg）等单位陷阱。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractHeightWeightFromText,
  extractQuantityFromText,
  inferWeightUnit,
  parseWeightValue,
} from './measurements.js'

test('inferWeightUnit 显式单位优先，无单位时 >=140 视为斤', () => {
  assert.equal(inferWeightUnit('100', '斤'), 'jin')
  assert.equal(inferWeightUnit('100', 'kg'), 'kg')
  assert.equal(inferWeightUnit('157'), 'jin')
  assert.equal(inferWeightUnit('139'), 'kg')
  assert.equal(inferWeightUnit('abc'), undefined)
})

test('parseWeightValue 斤按 2:1 折算为公斤并保留一位小数', () => {
  assert.equal(parseWeightValue('157', '斤'), 78.5)
  assert.equal(parseWeightValue('70'), 70)
  assert.equal(parseWeightValue('140'), 70) // 无单位大数走斤推断
  assert.equal(parseWeightValue('abc'), undefined)
})

test('带标签的身高体重：斤自动折算', () => {
  const r = extractHeightWeightFromText('身高175 体重140斤')
  assert.equal(r.heightCm, 175)
  assert.equal(r.weightKg, 70)
  assert.equal(r.inferredWeightUnit, 'jin')
})

test('标签带"是/改成"等动词连接也能抽取', () => {
  const r = extractHeightWeightFromText('身高是170，体重改成60kg')
  assert.equal(r.heightCm, 170)
  assert.equal(r.weightKg, 60)
  assert.equal(r.inferredWeightUnit, 'kg')
})

test('无标签裸数对："179, 157斤"（真实 session 39 写法）', () => {
  const r = extractHeightWeightFromText('179, 157斤')
  assert.equal(r.heightCm, 179)
  assert.equal(r.weightKg, 78.5)
  assert.equal(r.inferredWeightUnit, 'jin')
})

test('"181.70公斤" 解析为 181cm + 70kg（session 63 的句号拼写）', () => {
  const r = extractHeightWeightFromText('181.70公斤')
  assert.equal(r.heightCm, 181)
  assert.equal(r.weightKg, 70)
  assert.equal(r.inferredWeightUnit, 'kg')
})

test('cm/kg 后缀的独立数值也能各自抽到', () => {
  const r = extractHeightWeightFromText('175cm 60kg')
  assert.equal(r.heightCm, 175)
  assert.equal(r.weightKg, 60)
})

test('日期上下文里的数字不会被误认成体型', () => {
  const r = extractHeightWeightFromText('5月10日到5月12日')
  assert.equal(r.heightCm, undefined)
  assert.equal(r.weightKg, undefined)
})

test('真小数体重不被误拆："65.5公斤" 只是体重', () => {
  const r = extractHeightWeightFromText('65.5公斤')
  assert.equal(r.heightCm, undefined)
  assert.equal(r.weightKg, 65.5)
})

test('超出合理区间的数值被丢弃', () => {
  assert.equal(extractHeightWeightFromText('身高300').heightCm, undefined)
  assert.equal(extractHeightWeightFromText('体重15').weightKg, undefined)
})

test('extractQuantityFromText 识别阿拉伯数字与中文数字件量', () => {
  assert.equal(extractQuantityFromText('我要租2件'), 2)
  assert.equal(extractQuantityFromText('拍两套'), 2)
  assert.equal(extractQuantityFromText('想订三条'), 3)
  assert.equal(extractQuantityFromText('数量 3'), 3)
  assert.equal(extractQuantityFromText('件数是2'), 2)
})

test('extractQuantityFromText 没有租赁意图动词时不把量词当数量', () => {
  assert.equal(extractQuantityFromText('一件衣服的洗涤说明'), undefined)
})

test('extractQuantityFromText 不吞身高体重和日期数字', () => {
  assert.equal(extractQuantityFromText('身高170体重60kg'), undefined)
  assert.equal(extractQuantityFromText('5月10日'), undefined)
})

test('extractQuantityFromText 越界与空输入返回 undefined', () => {
  assert.equal(extractQuantityFromText('要0件'), undefined)
  assert.equal(extractQuantityFromText(''), undefined)
})
