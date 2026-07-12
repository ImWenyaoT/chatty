import Link from "next/link";
import { SellerNavigation } from "../components/seller/SellerNavigation";
import { WorkspaceHeader } from "../components/seller/WorkspaceHeader";
import { SELLER_ORDERS } from "../components/seller/orderData";
import { summarizeAutomationImpact } from "../components/seller/productMetrics";
import { getRepos } from "@/lib/db";
import { JobActions } from "./JobActions";
import { buildOperationsControlView } from "@/lib/control-plane-read-model";

// 复盘视图以演示会话/知识面板为主，但会读取 trace review 汇总，展示真实任务
// 反馈闭环的最小产品指标。质量回归仍由根级 `pnpm eval` 的朴素金标回归承担。
export const dynamic = "force-dynamic";

const KNOWLEDGE_BUCKETS = [
  { label: "规则政策", value: 12, hint: "租赁、押金、物流、退换" },
  { label: "商品档案", value: 8, hint: "西装、礼服、尺码表、图片说明" },
  { label: "历史问答", value: 24, hint: "客服沉淀的常见回复" },
];

/** 复盘视图：卖家会话、知识覆盖与 trace review 总览，实时问答在 Playground。 */
export default function DashboardPage() {
  const selected = SELLER_ORDERS[0];
  const reviewSummary = getRepos().reviews.summarize();
  const automationSummary = summarizeAutomationImpact(SELLER_ORDERS);
  const operations = buildOperationsControlView(getRepos().control);
  const jobs = operations.jobs.slice(0, 12);
  const outbox = operations.outbox.slice(0, 12);
  const topTags = Object.entries(reviewSummary.tags)
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 3);

  return (
    <main className="seller-dashboard" id="main-content">
      <SellerNavigation active="dashboard" />
      <WorkspaceHeader
        eyebrow="Trace review · Agent 复盘"
        title="复盘视图"
        actions={
          <>
            <Link href="/playground">客服会话</Link>
            <Link href="/orders">订单跟进</Link>
          </>
        }
      />

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
            <h2>AI 落地指标</h2>
            <span>BUSINESS IMPACT</span>
          </div>
          <div className="dashboard-knowledge">
            {automationSummary.metrics.map((metric) => (
              <article key={metric.label}>
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
                <p>{metric.hint}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>反馈闭环</h2>
            <span>TRACE REVIEW</span>
          </div>
          <div className="dashboard-detail-grid">
            <div>
              <span>已复核</span>
              <strong>{reviewSummary.total}</strong>
            </div>
            <div>
              <span>通过</span>
              <strong>{reviewSummary.pass}</strong>
            </div>
            <div>
              <span>需处理</span>
              <strong>{reviewSummary.fail + reviewSummary.flagged}</strong>
            </div>
            <div>
              <span>标签</span>
              <strong>
                {topTags.length
                  ? topTags.map(([tag, count]) => `${tag} ${count}`).join(" / ")
                  : "暂无"}
              </strong>
            </div>
          </div>
        </section>
      </section>

      <section className="dashboard-wide-panel">
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
      <section className="dashboard-wide-panel">
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>Background Jobs</h2>
            <span>
              {jobs.length} JOBS · {outbox.length} OUTBOX
            </span>
          </div>
          <div className="dashboard-conv-list">
            {jobs.length ? (
              jobs.map((job) => (
                <article key={job.id}>
                  <div>
                    <strong>{job.type}</strong>
                    <span>{job.status}</span>
                  </div>
                  <p>{job.conversationId ?? job.customerId ?? "global"}</p>
                  <small>
                    attempt {job.attempts}/{job.maxAttempts} · due {job.dueAt} ·
                    lease {job.leaseOwner ?? "none"} · heartbeat{" "}
                    {job.heartbeatAt ?? "unknown"}
                    {job.retryDelayMs !== undefined
                      ? ` · retry in ${job.retryDelayMs}ms`
                      : ""}
                    {job.lastError ? ` · ${job.lastError}` : ""}
                  </small>
                  <p>
                    事件：
                    {job.events.map((event) => event.type).join(" → ") ||
                      "暂无事件证据"}
                  </p>
                  <p>
                    取消：{job.status === "cancelled" ? "已取消" : "无取消证据"}
                  </p>
                  <JobActions jobId={job.id} status={job.status} />
                </article>
              ))
            ) : (
              <p>暂无后台任务</p>
            )}
          </div>
        </section>
      </section>
      <section
        className="dashboard-wide-panel"
        aria-label="Control Plane 健康指标"
      >
        <section className="dashboard-panel">
          <div className="dashboard-panel-head">
            <h2>Control Plane 健康指标</h2>
            <span>DURABLE EVIDENCE</span>
          </div>
          <div className="dashboard-detail-grid">
            <div>
              <span>Workflow failures</span>
              <strong>{operations.metrics.workflowFailures}</strong>
            </div>
            <div>
              <span>Compaction</span>
              <strong>
                {operations.metrics.compactions} / failed{" "}
                {operations.metrics.compactionFailures}
              </strong>
            </div>
            <div>
              <span>Memory no-op</span>
              <strong>{operations.metrics.memoryNoOps}</strong>
            </div>
            <div>
              <span>Retry rate</span>
              <strong>
                {operations.metrics.retryRate === null
                  ? "未知（无 attempt）"
                  : `${(operations.metrics.retryRate * 100).toFixed(1)}%`}
              </strong>
            </div>
            <div>
              <span>Follow-up latency</span>
              <strong>
                {operations.metrics.followupLatencyMs === null
                  ? "未知（无已完成 follow-up）"
                  : `${Math.round(operations.metrics.followupLatencyMs)} ms`}
              </strong>
            </div>
            <div>
              <span>Outbox delivery</span>
              <strong>
                {outbox.length
                  ? outbox
                      .map((message) => `${message.status}:${message.id}`)
                      .join(" / ")
                  : "暂无投递记录"}
              </strong>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
