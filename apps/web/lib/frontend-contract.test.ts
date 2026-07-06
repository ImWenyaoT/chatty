import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Reads a web app source file for lightweight UI contract assertions. */
function readAppSource(path: string) {
  return readFileSync(resolve(appRoot, path), 'utf8')
}

const layoutSource = readAppSource('app/layout.tsx')
const sellerNavigationSource = readAppSource('app/components/seller/SellerNavigation.tsx')
const homeSource = readAppSource('app/page.tsx')
const dashboardSource = readAppSource('app/dashboard/page.tsx')
const ordersSource = readAppSource('app/orders/page.tsx')
const orderDataSource = readAppSource('app/components/seller/orderData.ts')
const playgroundSource = readAppSource('app/playground/page.tsx')
const cssSource = readAppSource('app/globals.css')

test('frontend shell exposes keyboard and screen-reader navigation affordances', () => {
  assert.match(layoutSource, /className="skip-link"/)
  assert.match(layoutSource, /href="#main-content"/)
  assert.match(homeSource, /id="main-content"/)
  assert.match(dashboardSource, /id="main-content"/)
  assert.match(ordersSource, /id="main-content"/)
  assert.match(playgroundSource, /id="main-content"/)
  assert.match(playgroundSource, /role="status"/)
  assert.match(playgroundSource, /role="log"/)
  assert.match(playgroundSource, /aria-busy=\{sending\}/)
})

test('playground controls expose state beyond color alone', () => {
  assert.match(playgroundSource, /aria-label="发送客户消息"/)
  assert.match(playgroundSource, /aria-label="客户消息"/)
  assert.match(playgroundSource, /<fieldset className="legacy-review-options">/)
  assert.match(playgroundSource, /<legend>复核结果<\/legend>/)
  assert.match(playgroundSource, /aria-pressed=\{review\.label === option\.label\}/)
})

test('frontend CSS keeps focus visible and mobile touch targets large enough', () => {
  assert.match(cssSource, /\.skip-link/)
  assert.match(cssSource, /:focus-visible/)
  assert.match(cssSource, /box-shadow: var\(--focus-ring\)/)
  assert.match(cssSource, /min-height: 44px/)
})

test('seller workspace cannot regress to a chat-only page', () => {
  assert.match(sellerNavigationSource, /href: '\/'/)
  assert.match(sellerNavigationSource, /href: '\/playground'/)
  assert.match(sellerNavigationSource, /href: '\/orders'/)
  assert.match(sellerNavigationSource, /label: '卖家首页'/)
  assert.match(sellerNavigationSource, /label: '客服会话'/)
  assert.match(sellerNavigationSource, /label: '订单管理'/)
})

test('customer service workspace keeps product language with technical observability', () => {
  assert.match(sellerNavigationSource, /label: '客服会话'/)
  assert.match(playgroundSource, /<h2>实时会话<\/h2>/)
  assert.match(playgroundSource, /<h2>记忆<\/h2>/)
  assert.match(playgroundSource, /<h2>知识命中<\/h2>/)
  assert.match(playgroundSource, /<h2>订单待办<\/h2>/)
  assert.match(playgroundSource, /<h2>本轮复核<\/h2>/)
  assert.match(playgroundSource, /<summary>开发调试<\/summary>/)
})

test('order operations stays as workflow evidence instead of an empty route', () => {
  assert.match(ordersSource, /aria-label="搜索订单"/)
  assert.match(ordersSource, /<h3>履约进度<\/h3>/)
  assert.match(ordersSource, /<h3>订单时间线<\/h3>/)
  assert.match(orderDataSource, /status: '待复核'/)
  assert.match(orderDataSource, /status: '待发货'/)
  assert.match(orderDataSource, /status: '租赁中'/)
  assert.match(playgroundSource, /fetch\('\/api\/orders\/place'/)
  assert.match(playgroundSource, /提交订单号，标记已下单/)
})

test('review dashboard copy avoids generic backend-dashboard language', () => {
  const visibleShellCopy = [homeSource, dashboardSource, sellerNavigationSource].join('\n')
  assert.doesNotMatch(visibleShellCopy, /后台视图/)
  assert.doesNotMatch(visibleShellCopy, /后台观察/)
  assert.doesNotMatch(visibleShellCopy, /智能客服后台/)
  assert.match(visibleShellCopy, /复盘视图/)
})
