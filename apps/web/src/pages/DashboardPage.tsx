import { useEffect, useState } from "react";
import { SellerNavigation } from "../components/seller/SellerNavigation";
import { WorkspaceHeader } from "../components/seller/WorkspaceHeader";

const API_BASE_URL = "/api/chatty";

type TraceSpan = {
  span_id: string;
  trace_id: string;
  parent_id: string | null;
  span_type: string;
  status: string;
  summary: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  error: string | null;
};

type Trace = {
  trace_id: string;
  session_id: string;
  status: string;
  summary: string;
  model_id: string;
  span_types: string[];
  created_at: string;
  updated_at: string;
  duration_ms: number;
  business_outcome: string | null;
  completion_evidence: string | null;
  knowledge_sources: string[];
  memory_sources: string[];
  support_request_id: string | null;
  spans: TraceSpan[];
};

type TraceDashboard = {
  traces: Trace[];
  order_status_counts: Record<string, number>;
};

const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
};

const OUTCOME_LABELS: Record<string, string> = {
  verified: "业务已验证",
  not_completed: "业务未完成",
  not_applicable: "无需业务变更",
};

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<TraceDashboard>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<Trace>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");

  useEffect(() => {
    const abortController = new AbortController();
    async function loadTraces() {
      try {
        const response = await fetch(`${API_BASE_URL}/traces`, {
          signal: abortController.signal,
        });
        if (!response.ok)
          throw new Error("无法读取 Trace，请确认 FastAPI 已启动");
        const payload = (await response.json()) as TraceDashboard;
        if (!Array.isArray(payload.traces))
          throw new Error("Trace 接口返回格式错误");
        setDashboard(payload);
        setSelectedId(payload.traces[0]?.trace_id);
      } catch (caught) {
        if (!abortController.signal.aborted) {
          setListError(
            caught instanceof Error ? caught.message : "无法读取 Trace",
          );
        }
      } finally {
        if (!abortController.signal.aborted) setLoading(false);
      }
    }
    void loadTraces();
    return () => abortController.abort();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const abortController = new AbortController();
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/traces/${selectedId}`, {
          signal: abortController.signal,
        });
        if (!response.ok) throw new Error("无法读取 Trace 详情");
        setDetail((await response.json()) as Trace);
      } catch (caught) {
        if (!abortController.signal.aborted) {
          setDetailError(
            caught instanceof Error ? caught.message : "无法读取 Trace 详情",
          );
        }
      } finally {
        if (!abortController.signal.aborted) setDetailLoading(false);
      }
    }
    void loadDetail();
    return () => abortController.abort();
  }, [selectedId]);

  const counts = dashboard?.order_status_counts;

  function selectTrace(traceId: string) {
    if (traceId !== selectedId) {
      setDetail(undefined);
      setDetailError(undefined);
      setSelectedId(traceId);
    }
    setMobilePane("detail");
  }

  return (
    <main className="seller-dashboard trace-dashboard" id="main-content">
      <SellerNavigation active="dashboard" />
      <WorkspaceHeader eyebrow="SQLite Trace · Agent 复盘" title="复盘视图" />

      {loading ? <p role="status">正在读取 Trace…</p> : null}
      {listError ? <p role="alert">{listError}</p> : null}
      {!loading && !listError && dashboard?.traces.length === 0 ? (
        <section className="dashboard-panel trace-empty">
          <h2>暂无 Agent Run</h2>
          <p>从客服会话发起一次请求后，这里会显示本地 SQLite Trace。</p>
        </section>
      ) : null}

      {!loading && dashboard?.traces.length ? (
        <>
          <section className="trace-order-counts" aria-label="真实订单状态计数">
            <span>待确认 {counts?.pending ?? 0}</span>
            <span>已确认 {counts?.confirmed ?? 0}</span>
            <span>已取消 {counts?.cancelled ?? 0}</span>
          </section>

          <div className="trace-layout" data-mobile-pane={mobilePane}>
            <aside
              className="dashboard-panel trace-list"
              aria-label="Agent Run 列表"
            >
              <div className="dashboard-panel-head">
                <h2>最近 Agent Runs</h2>
                <span>{dashboard.traces.length} RUNS</span>
              </div>
              {dashboard.traces.map((trace) => (
                <button
                  className={trace.trace_id === selectedId ? "active" : ""}
                  key={trace.trace_id}
                  type="button"
                  aria-label={`查看 ${trace.trace_id}`}
                  onClick={() => selectTrace(trace.trace_id)}
                >
                  <span className={`trace-status trace-status-${trace.status}`}>
                    {STATUS_LABELS[trace.status] ?? trace.status}
                  </span>
                  <strong>{trace.session_id}</strong>
                  <small>{trace.trace_id}</small>
                  <small>
                    {formatDateTime(trace.created_at)} ·{" "}
                    {formatDuration(trace.duration_ms)}
                  </small>
                </button>
              ))}
            </aside>

            <section
              className="dashboard-panel trace-detail"
              aria-busy={detailLoading}
            >
              {detailLoading ? <p role="status">正在读取 Run 详情…</p> : null}
              {detailError ? <p role="alert">{detailError}</p> : null}
              {detail ? (
                <TraceDetail
                  trace={detail}
                  onBack={() => setMobilePane("list")}
                />
              ) : null}
            </section>
          </div>
        </>
      ) : null}
    </main>
  );
}

function TraceDetail({ trace, onBack }: { trace: Trace; onBack: () => void }) {
  const [detailTab, setDetailTab] = useState<"evidence" | "spans">("evidence");

  return (
    <>
      <div className="dashboard-panel-head">
        <button className="mobile-back" type="button" onClick={onBack}>
          返回
        </button>
        <div>
          <h2>Run 详情</h2>
          <span>{trace.trace_id}</span>
        </div>
        <span className={`trace-status trace-status-${trace.status}`}>
          {STATUS_LABELS[trace.status] ?? trace.status}
        </span>
      </div>

      <dl className="trace-facts">
        <div>
          <dt>Session</dt>
          <dd>{trace.session_id}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{trace.model_id}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{formatDuration(trace.duration_ms)}</dd>
        </div>
        <div>
          <dt>业务状态</dt>
          <dd>{OUTCOME_LABELS[trace.business_outcome ?? ""] ?? "未记录"}</dd>
        </div>
      </dl>

      <div
        className="pane-tabs trace-detail-tabs"
        role="tablist"
        aria-label="Run 详情"
      >
        <button
          aria-selected={detailTab === "evidence"}
          className={detailTab === "evidence" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setDetailTab("evidence")}
        >
          完成证据
        </button>
        <button
          aria-selected={detailTab === "spans"}
          className={detailTab === "spans" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setDetailTab("spans")}
        >
          Model / Tool spans
        </button>
      </div>

      {detailTab === "evidence" ? (
        <div className="trace-evidence-list">
          <Evidence
            title="业务完成证据"
            values={
              trace.completion_evidence ? [trace.completion_evidence] : []
            }
          />
          <Evidence title="知识来源" values={trace.knowledge_sources} />
          <Evidence title="Memory 来源" values={trace.memory_sources} />
          <Evidence
            title="Handoff receipt"
            values={trace.support_request_id ? [trace.support_request_id] : []}
          />
        </div>
      ) : null}

      {detailTab === "spans" ? (
        <section className="trace-spans">
          <h3>Model / Tool spans</h3>
          {trace.spans.length ? (
            <ol>
              {trace.spans.map((span) => (
                <li key={span.span_id}>
                  <div>
                    <strong>{span.span_type}</strong>
                    <span
                      className={`trace-status trace-status-${span.status}`}
                    >
                      {STATUS_LABELS[span.status] ?? span.status}
                    </span>
                  </div>
                  <p>{span.summary}</p>
                  <small>
                    {formatDuration(span.duration_ms)}
                    {span.parent_id ? ` · parent ${span.parent_id}` : " · root"}
                  </small>
                  {span.error ? (
                    <p className="trace-error">错误：{span.error}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p>暂无 span 证据</p>
          )}
        </section>
      ) : null}
    </>
  );
}

function Evidence({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="trace-evidence">
      <h3>{title}</h3>
      {values.length ? (
        <ul>
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      ) : (
        <p>无</p>
      )}
    </section>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatDuration(value: number | null): string {
  return value === null ? "未知" : `${value} ms`;
}
