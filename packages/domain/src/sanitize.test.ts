// sanitizeAnswerText 的单元测试：钉住 Markdown 痕迹清除、空行压缩、标点修复的既有行为。
import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeAnswerText } from './sanitize.js'

test('去掉 Markdown 图片语法（图片通道随 RW-1 舍弃，防御 LLM 编造路径）', () => {
  assert.equal(
    sanitizeAnswerText('这是实拍图 ![西装](/media/suit.jpg) 您看下'),
    '这是实拍图  您看下',
  )
})

test('普通 Markdown 链接只保留文字，丢掉 url', () => {
  assert.equal(sanitizeAnswerText('详见[租赁规则](https://example.com/rule)哦'), '详见租赁规则哦')
})

test('星号全部剔除（不允许 Markdown 加粗痕迹）', () => {
  assert.equal(sanitizeAnswerText('**重点**：首日全价'), '重点：首日全价')
})

test('三连以上空行压成一个空行', () => {
  assert.equal(sanitizeAnswerText('第一段\n\n\n\n第二段'), '第一段\n\n第二段')
})

test('标点前空白删除、重复标点去重、首尾空白裁剪', () => {
  assert.equal(sanitizeAnswerText('  好的 ，收到。。您说 ！ '), '好的，收到。您说！')
})

test('干净文本原样通过', () => {
  assert.equal(sanitizeAnswerText('好，档期这边记上了。'), '好，档期这边记上了。')
})
