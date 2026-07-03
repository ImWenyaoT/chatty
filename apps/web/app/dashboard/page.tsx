import Link from 'next/link'
import { SellerNavigation } from '../components/seller/SellerNavigation'
import { SELLER_ORDERS } from '../components/seller/orderData'

const REVIEW_ROWS = [
  { version: 'v1-current', count: 18, score: '8.4', low: '1', errors: '0' },
  { version: 'v0-legacy', count: 11, score: '7.7', low: '2', errors: '1' },
]

const KNOWLEDGE_BUCKETS = [
  { label: '规则政策', value: 12, hint: '租赁、押金、物流、退换' },
  { label: '商品档案', value: 8, hint: '西装、礼服、尺码表、图片说明' },
  { label: '历史问答', value: 24, hint: '客服沉淀的常见回复' },
]

/** Restores the original dashboard's business structure: reviews, conversations and knowledge. */
export default function DashboardPage() {
  const selected = SELLER_ORDERS[0]
  return (
    <main className="seller-dashboard">
      <SellerNavigation active="dashboard" />
      <header className="dashboard-header">
        <div>
          <p>NEXUS · 智能客服评测中枢</p>
          <h1>后台视图</h1>
        </div>
        <div className="dashboard-actions">
          <Link href="/playground">客服会话</Link>
          <Link href="/orders">订单管理</Link>
        </div>
      </header>

      <section className="dashboard-cards">
        <article>
          <span>当前版本</span>
          <strong>v1-current</strong>
          <p>当前客服策略版本</p>
        </article>
        <article>
          <span>评价总数</span>
          <strong>29</strong>
          <p>{SELLER_ORDERS.length} 个会话样本</p>
        </article>
        <article>
          <span>平均分</span>
          <strong>8.4</strong>
          <p>低分样本需要复盘</p>
        </article>
        <article>
          <span>知识片段</span>
          <strong>44</strong>
          <p>规则 / 商品 / 历史问答</p>
        </article>
      </section>

      <section className="dashboard-two-col">
        <aside className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>会话列表</h2>
            <span>LIVE · 自动刷新</span>
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
          <div className="dashboard-review">
            <h3>评估历史</h3>
            <article>
              <strong>8.6</strong>
              <p>回复覆盖价格、档期和尺码复核，但下单 CTA 还可以更明确。</p>
            </article>
            <article>
              <strong>7.8</strong>
              <p>用户已经给出体型时，应减少重复追问，直接推进复核。</p>
            </article>
          </div>
        </section>
      </section>

      <section className="dashboard-two-col">
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>版本对比</h2>
            <span>Prompt Version Benchmark</span>
          </div>
          <div className="dashboard-version-table">
            {REVIEW_ROWS.map((row) => (
              <div key={row.version}>
                <strong>{row.version}</strong>
                <span>{row.count} reviews</span>
                <span>avg {row.score}</span>
                <span>low {row.low}</span>
                <span>err {row.errors}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>知识库管理</h2>
            <span>查看、检索、新增与删除知识片段</span>
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
          <div className="dashboard-search-row">
            <input placeholder="按内容或标题搜索..." />
            <button type="button">搜索</button>
            <button type="button">新增知识</button>
          </div>
        </section>
      </section>

      <section className="dashboard-two-col">
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>高频问题 Top 10</h2>
          </div>
          <ul className="dashboard-list">
            <li>价格说明不够明确</li>
            <li>用户给出档期后仍重复追问</li>
            <li>尺码复核前缺少人工确认提示</li>
          </ul>
        </section>
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>高频建议 Top 10</h2>
          </div>
          <ul className="dashboard-list">
            <li>把首日价、续租价和押金拆开写</li>
            <li>显式告诉卖家下一步是否需要复核</li>
            <li>售后问题优先转人工并带上上下文</li>
          </ul>
        </section>
      </section>
    </main>
  )
}
