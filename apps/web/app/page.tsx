import Link from 'next/link'
import { SellerNavigation } from './components/seller/SellerNavigation'
import { SELLER_ORDERS } from './components/seller/orderData'
import {
  getSellerWorkspaceRoute,
  sellerWorkspaceHomeRoutes,
} from './components/seller/sellerWorkspaceRoutes'
import { summarizeAutomationImpact } from './components/seller/productMetrics'

/** Shows the seller-side product home with the workspace split across focused routes. */
export default function SellerHomePage() {
  const activeOrders = SELLER_ORDERS.filter((order) => order.status !== '租赁中').length
  const riskOrders = SELLER_ORDERS.filter((order) => order.risk !== '无').length
  const playgroundRoute = getSellerWorkspaceRoute('playground')
  const ordersRoute = getSellerWorkspaceRoute('orders')
  const automationSummary = summarizeAutomationImpact(SELLER_ORDERS)

  return (
    <main className="seller-home" id="main-content">
      <SellerNavigation active="home" />
      <section className="seller-home-hero">
        <div>
          <p>卖家工作台</p>
          <h1>Chatty 把客服、订单和复盘拆成清晰的卖家工作流。</h1>
          <span>首页看经营概览；客服会话处理客户；订单跟进处理履约；复盘视图看质量和提效。</span>
        </div>
        <div className="seller-home-actions">
          <Link href={playgroundRoute.href}>进入客服会话</Link>
          <Link href={ordersRoute.href}>查看跟进</Link>
        </div>
      </section>

      <section className="seller-home-grid">
        <article>
          <span>今日待处理订单</span>
          <strong>{activeOrders}</strong>
          <p>待复核 / 待发货优先处理</p>
        </article>
        <article>
          <span>需要人工注意</span>
          <strong>{riskOrders}</strong>
          <p>尺码复核、归还提醒、地址补全</p>
        </article>
        <article>
          <span>对话入口</span>
          <strong>客服会话</strong>
          <p>卖家处理客户咨询、查看客户资料、推进订单。</p>
        </article>
      </section>

      <section className="seller-impact-panel" aria-labelledby="seller-impact-title">
        <div className="seller-impact-head">
          <div>
            <p>AI 落地指标</p>
            <h2 id="seller-impact-title">把客服会话变成可复盘的数字员工。</h2>
          </div>
          <span>{automationSummary.totalOrders} 个演示订单样本</span>
        </div>
        <div className="seller-impact-grid">
          {automationSummary.metrics.map((metric) => (
            <article key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <p>{metric.hint}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="seller-home-routes">
        {sellerWorkspaceHomeRoutes.map((route) => (
          <Link href={route.href} key={route.key}>
            <span>{route.homeEyebrow}</span>
            <strong>{route.homeTitle}</strong>
            <p>{route.homeDescription}</p>
          </Link>
        ))}
      </section>
    </main>
  )
}
