import Link from 'next/link'
import { SellerNavigation } from './components/seller/SellerNavigation'
import { SELLER_ORDERS } from './components/seller/orderData'
import {
  getSellerWorkspaceRoute,
  sellerWorkspaceHomeRoutes,
} from './components/seller/sellerWorkspaceRoutes'

/** Shows the seller-side home console instead of dropping users into a one-page chat demo. */
export default function SellerHomePage() {
  const activeOrders = SELLER_ORDERS.filter((order) => order.status !== '租赁中').length
  const riskOrders = SELLER_ORDERS.filter((order) => order.risk !== '无').length
  const playgroundRoute = getSellerWorkspaceRoute('playground')
  const ordersRoute = getSellerWorkspaceRoute('orders')

  return (
    <main className="seller-home" id="main-content">
      <SellerNavigation active="home" />
      <section className="seller-home-hero">
        <div>
          <p>卖家工作台</p>
          <h1>Chatty 是卖家端客服后台，不是买家聊天页。</h1>
          <span>客服会话、客户资料、订单管理、复盘视图分开进入。</span>
        </div>
        <div className="seller-home-actions">
          <Link href={playgroundRoute.href}>进入客服会话</Link>
          <Link href={ordersRoute.href}>查看订单</Link>
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
