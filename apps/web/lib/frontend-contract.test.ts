import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MINIMUM_SELLER_WORKSPACE_ROUTE_KEYS,
  SELLER_WORKSPACE_ROUTES,
  sellerWorkspaceHomeRoutes,
} from '../app/components/seller/sellerWorkspaceRoutes'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Reads a web app source file for lightweight UI contract assertions. */
function readAppSource(path: string) {
  return readFileSync(resolve(appRoot, path), 'utf8')
}

const layoutSource = readAppSource('app/layout.tsx')
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
  assert.match(playgroundSource, /<h2>客户队列<\/h2>/)
  assert.match(playgroundSource, /support-inbox-shell/)
  assert.match(playgroundSource, /className="legacy-composer-box"/)
  assert.match(playgroundSource, /aria-label="添加客户图片"/)
  assert.match(playgroundSource, /aria-label="发送"/)
  assert.doesNotMatch(playgroundSource, /客户详情/)
  assert.doesNotMatch(playgroundSource, /清空/)
})

test('frontend CSS keeps focus visible and mobile touch targets large enough', () => {
  assert.match(cssSource, /\.skip-link/)
  assert.match(cssSource, /:focus-visible/)
  assert.match(cssSource, /box-shadow: var\(--focus-ring\)/)
  assert.match(cssSource, /min-height: 44px/)
  assert.match(cssSource, /scroll-snap-type: x mandatory/)
  assert.match(cssSource, /\.legacy-composer-box:focus-within/)
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*\.legacy-composer-box button/)
  assert.doesNotMatch(cssSource, /support-detail-panel/)
})

test('seller workspace cannot regress to a chat-only page', () => {
  assert.deepEqual(MINIMUM_SELLER_WORKSPACE_ROUTE_KEYS, ['home', 'playground', 'orders'])
  assert.deepEqual(
    SELLER_WORKSPACE_ROUTES.map((route) => [route.key, route.href, route.navLabel]),
    [
      ['home', '/', '卖家首页'],
      ['playground', '/playground', '客服会话'],
      ['orders', '/orders', '订单跟进'],
      ['dashboard', '/dashboard', '复盘视图'],
    ],
  )
  assert.deepEqual(
    sellerWorkspaceHomeRoutes.map((route) => route.key),
    ['playground', 'orders', 'dashboard'],
  )
})

test('customer service workspace keeps product language with technical observability', () => {
  assert.equal(
    SELLER_WORKSPACE_ROUTES.find((route) => route.key === 'playground')?.navLabel,
    '客服会话',
  )
  assert.match(playgroundSource, /<h2>实时会话<\/h2>/)
  assert.match(playgroundSource, /<h2>客户队列<\/h2>/)
  assert.match(playgroundSource, /className="legacy-composer-box"/)
  assert.match(playgroundSource, /className="legacy-attachment-details"/)
  assert.match(playgroundSource, /className="legacy-send-button"/)
  assert.doesNotMatch(playgroundSource, /className="legacy-inspector"/)
  assert.doesNotMatch(playgroundSource, /className="service-context-panel"/)
  assert.doesNotMatch(playgroundSource, /<h2>客户上下文<\/h2>/)
  assert.doesNotMatch(playgroundSource, /<h2>知识命中<\/h2>/)
  assert.doesNotMatch(playgroundSource, /<h2>订单待办<\/h2>/)
  assert.doesNotMatch(playgroundSource, /会话配置/)
  assert.doesNotMatch(playgroundSource, /高级设置/)
  assert.doesNotMatch(playgroundSource, /前端调试/)
  assert.doesNotMatch(playgroundSource, /开发调试/)
  assert.doesNotMatch(playgroundSource, /本轮复核/)
  assert.doesNotMatch(playgroundSource, /固定测试/)
})

test('control-plane surfaces render durable status and explicit unknown or empty evidence', () => {
  assert.match(playgroundSource, /controlPlane\?\.workflow\.displayState \?\? 'unknown'/)
  assert.match(playgroundSource, /排队消息/)
  assert.match(playgroundSource, /已过期，等待恢复/)
  assert.match(playgroundSource, /无 heartbeat 证据/)
  assert.match(playgroundSource, /控制面状态读取失败/)
  assert.match(dashboardSource, /job\.events/)
  assert.match(dashboardSource, /暂无事件证据/)
  assert.match(dashboardSource, /未知（无 attempt）/)
  assert.match(dashboardSource, /暂无投递记录/)
})

test('order operations stays as workflow evidence instead of an empty route', () => {
  const visibleOrderCopy = [dashboardSource, ordersSource, JSON.stringify(SELLER_WORKSPACE_ROUTES)]
    .join('\n')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')

  assert.doesNotMatch(visibleOrderCopy, /订单管理/)
  assert.match(visibleOrderCopy, /订单跟进/)
  assert.match(ordersSource, /aria-label="搜索订单"/)
  assert.match(ordersSource, /<h3>履约进度<\/h3>/)
  assert.match(ordersSource, /<h3>订单时间线<\/h3>/)
  assert.match(orderDataSource, /status: '待复核'/)
  assert.match(orderDataSource, /status: '待发货'/)
  assert.match(orderDataSource, /status: '租赁中'/)
  assert.match(orderDataSource, /mode: 'ai_resolved'/)
  assert.match(ordersSource, /AI 证据/)
  assert.match(ordersSource, /节省/)
  assert.doesNotMatch(playgroundSource, /fetch\('\/api\/orders\/place'/)
  assert.doesNotMatch(playgroundSource, /提交订单号，标记已下单/)
})

test('review dashboard copy avoids generic backend-dashboard language', () => {
  const visibleShellCopy = [
    homeSource,
    dashboardSource,
    JSON.stringify(SELLER_WORKSPACE_ROUTES),
  ].join('\n')
  assert.doesNotMatch(visibleShellCopy, /后台视图/)
  assert.doesNotMatch(visibleShellCopy, /后台观察/)
  assert.doesNotMatch(visibleShellCopy, /智能客服后台/)
  assert.match(visibleShellCopy, /AI 落地指标/)
  assert.match(visibleShellCopy, /可复盘的数字员工/)
  assert.match(dashboardSource, /BUSINESS IMPACT/)
  assert.match(visibleShellCopy, /复盘视图/)
})
