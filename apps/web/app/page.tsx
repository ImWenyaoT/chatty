import Link from 'next/link'
import { SellerNavigation } from './components/seller/SellerNavigation'
import { SELLER_ORDERS } from './components/seller/orderData'

/** Shows the seller-side home console instead of dropping users into a one-page chat demo. */
export default function SellerHomePage() {
  const activeOrders = SELLER_ORDERS.filter((order) => order.status !== '租赁中').length
  const riskOrders = SELLER_ORDERS.filter((order) => order.risk !== '无').length

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
          <Link href="/playground">进入客服会话</Link>
          <Link href="/orders">查看订单</Link>
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
        <Link href="/playground">
          <span>实时会话</span>
          <strong>客服会话</strong>
          <p>客户信息、会话记录、订单状态和手动录单放在同一工作流里。</p>
        </Link>
        <Link href="/orders">
          <span>订单运营</span>
          <strong>订单管理</strong>
          <p>订单列表、订单详情、履约进度、手动录单表单。</p>
        </Link>
        <Link href="/dashboard">
          <span>复盘视图</span>
          <strong>Trace Review</strong>
          <p>查看知识覆盖、样例会话和人工 trace review 汇总，用来复盘 agent 行为。</p>
        </Link>
      </section>
    </main>
  )
}
