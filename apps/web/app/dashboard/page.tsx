import Link from 'next/link'
import { SellerNavigation } from '../components/seller/SellerNavigation'
import { SELLER_ORDERS } from '../components/seller/orderData'

// 纯演示后台：会话/知识面板沿用卖家演示数据，无按请求变化的数据源，可静态渲染。
// 质量回归不在此页——由根级 `pnpm eval` 的朴素金标回归承担
// （报告落 eval/reports/），评测飞轮已退役。

const KNOWLEDGE_BUCKETS = [
  { label: '规则政策', value: 12, hint: '租赁、押金、物流、退换' },
  { label: '商品档案', value: 8, hint: '西装、礼服、尺码表、图片说明' },
  { label: '历史问答', value: 24, hint: '客服沉淀的常见回复' },
]

/** 后台视图：卖家会话与知识库总览（演示数据），实时问答在 Playground。 */
export default function DashboardPage() {
  const selected = SELLER_ORDERS[0]
  return (
    <main className="seller-dashboard">
      <SellerNavigation active="dashboard" />
      <header className="dashboard-header">
        <div>
          <p>NEXUS · 智能客服后台</p>
          <h1>后台视图</h1>
        </div>
        <div className="dashboard-actions">
          <Link href="/playground">客服会话</Link>
          <Link href="/orders">订单管理</Link>
        </div>
      </header>

      <section className="dashboard-two-col">
        <aside className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>会话列表</h2>
            <span>DEMO 样例数据</span>
          </div>
          <div className="dashboard-conv-list">
            {SELLER_ORDERS.map((order) => (
              <Link href="/orders" key={order.id}>
                <div>
                  <strong>{order.customer}</strong>
                  <span>{order.status}</span>
                </div>
                <p>{order.product}</p>
                <small>
                  {order.id} · {order.updatedAt}
                </small>
              </Link>
            ))}
          </div>
        </aside>

        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>会话详情</h2>
            <span>{selected.id}</span>
          </div>
          <div className="dashboard-detail-grid">
            <div>
              <span>客户</span>
              <strong>{selected.customer}</strong>
            </div>
            <div>
              <span>商品</span>
              <strong>{selected.product}</strong>
            </div>
            <div>
              <span>档期</span>
              <strong>{selected.period}</strong>
            </div>
            <div>
              <span>风险</span>
              <strong>{selected.risk}</strong>
            </div>
          </div>
        </section>
      </section>

      <section className="dashboard-two-col">
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>知识库概览</h2>
            <span>DEMO 样例数据</span>
          </div>
          <div className="dashboard-knowledge">
            {KNOWLEDGE_BUCKETS.map((bucket) => (
              <article key={bucket.label}>
                <strong>{bucket.value}</strong>
                <span>{bucket.label}</span>
                <p>{bucket.hint}</p>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  )
}
