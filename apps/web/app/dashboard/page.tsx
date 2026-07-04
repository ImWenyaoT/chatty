import Link from 'next/link'
import { DEFAULT_FAILURE_SCORE_THRESHOLD } from '@rental/agent-core'
import type { TraceReview } from '@rental/db'
import { getRepos } from '@/lib/db'
import { SellerNavigation } from '../components/seller/SellerNavigation'
import { SELLER_ORDERS } from '../components/seller/orderData'

// 评测数据必须每次请求现读 trace_reviews，不能在 build 时被静态化成空态。
export const dynamic = 'force-dynamic'

const EMPTY_HINT =
  '暂无评测数据：在 Playground 对话后由 LLM-judge 异步生成（需配置 OPENAI_API_KEY）'

const KNOWLEDGE_BUCKETS = [
  { label: '规则政策', value: 12, hint: '租赁、押金、物流、退换' },
  { label: '商品档案', value: 8, hint: '西装、礼服、尺码表、图片说明' },
  { label: '历史问答', value: 24, hint: '客服沉淀的常见回复' },
]

/** 汇总真实 reviews：总数、平均分、低分数与最新 promptVersion。 */
function summarizeReviews(reviews: TraceReview[]) {
  const total = reviews.length
  const avg = total ? reviews.reduce((sum, r) => sum + r.score, 0) / total : undefined
  const low = reviews.filter((r) => r.score < DEFAULT_FAILURE_SCORE_THRESHOLD).length
  const latestVersion = reviews.find((r) => r.promptVersion)?.promptVersion
  return { total, avg, low, latestVersion }
}

/** 按 promptVersion 分组出版本对比行（newest-first 输入，保持首次出现顺序）。 */
function groupByVersion(reviews: TraceReview[]) {
  const rows = new Map<string, { count: number; sum: number; low: number }>()
  for (const review of reviews) {
    const version = review.promptVersion ?? 'unknown'
    const row = rows.get(version) ?? { count: 0, sum: 0, low: 0 }
    row.count += 1
    row.sum += review.score
    if (review.score < DEFAULT_FAILURE_SCORE_THRESHOLD) row.low += 1
    rows.set(version, row)
  }
  return [...rows.entries()].map(([version, row]) => ({
    version,
    count: row.count,
    avg: (row.sum / row.count).toFixed(1),
    low: row.low,
  }))
}

/** 统计 reviews 里某个字符串数组字段的高频条目（如 issues/suggestions）。 */
function topEntries(reviews: TraceReview[], pick: (r: TraceReview) => string[], limit = 5) {
  const counts = new Map<string, number>()
  for (const review of reviews) {
    for (const entry of pick(review)) {
      counts.set(entry, (counts.get(entry) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }))
}

/** 后台视图：评测中枢读真实 trace_reviews 聚合，会话/知识面板沿用卖家演示数据。 */
export default function DashboardPage() {
  const reviews = getRepos().reviews.listRecent(100)
  const stats = summarizeReviews(reviews)
  const versionRows = groupByVersion(reviews)
  const topIssues = topEntries(reviews, (r) => r.issues)
  const topSuggestions = topEntries(reviews, (r) => r.suggestions)
  const recentReviews = reviews.slice(0, 3)
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
          <strong>{stats.latestVersion ?? '—'}</strong>
          <p>最近一次评测的 promptVersion</p>
        </article>
        <article>
          <span>评价总数</span>
          <strong>{stats.total}</strong>
          <p>trace_reviews 表实时统计</p>
        </article>
        <article>
          <span>平均分</span>
          <strong>{stats.avg === undefined ? '—' : stats.avg.toFixed(1)}</strong>
          <p>低分样本需要复盘</p>
        </article>
        <article>
          <span>低分样本</span>
          <strong>{stats.low}</strong>
          <p>{`score < ${DEFAULT_FAILURE_SCORE_THRESHOLD} 自动晋升 failure_case`}</p>
        </article>
      </section>

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
          <div className="dashboard-review">
            <h3>评估历史</h3>
            {recentReviews.length === 0 ? (
              <p>{EMPTY_HINT}</p>
            ) : (
              recentReviews.map((review) => (
                <article key={review.id}>
                  <strong>{review.score.toFixed(1)}</strong>
                  <p>
                    {[...review.issues, ...review.suggestions].join('；') || '无问题与建议记录'}
                  </p>
                </article>
              ))
            )}
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
            {versionRows.length === 0 ? (
              <p>{EMPTY_HINT}</p>
            ) : (
              versionRows.map((row) => (
                <div key={row.version}>
                  <strong>{row.version}</strong>
                  <span>{row.count} reviews</span>
                  <span>avg {row.avg}</span>
                  <span>low {row.low}</span>
                </div>
              ))
            )}
          </div>
        </section>

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

      <section className="dashboard-two-col">
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>高频问题 Top {topIssues.length || 5}</h2>
          </div>
          <ul className="dashboard-list">
            {topIssues.length === 0 ? (
              <li>{EMPTY_HINT}</li>
            ) : (
              topIssues.map((item) => (
                <li key={item.text}>
                  {item.text}（{item.count} 次）
                </li>
              ))
            )}
          </ul>
        </section>
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>高频建议 Top {topSuggestions.length || 5}</h2>
          </div>
          <ul className="dashboard-list">
            {topSuggestions.length === 0 ? (
              <li>{EMPTY_HINT}</li>
            ) : (
              topSuggestions.map((item) => (
                <li key={item.text}>
                  {item.text}（{item.count} 次）
                </li>
              ))
            )}
          </ul>
        </section>
      </section>
    </main>
  )
}
