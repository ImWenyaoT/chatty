import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fetchConfig, fetchCustomers, fetchSummary, triggerReEvaluate } from './api';
import type { ConfigInfo, CustomerListItem, ProductMemory, Review, ReviewSummary } from './types';

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number>(0);
  const reload = async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError(undefined);
      setLastUpdated(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, lastUpdated, reload };
}

// 渲染一次静态相对时间（不再随秒级 ticker 刷新，随数据刷新重渲染时更新）
function formatRelative(ts: number): string {
  if (!ts) return '—';
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 5) return '刚刚';
  if (diff < 60) return diff + 's ago';
  const m = Math.floor(diff / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ago';
}

function scoreColor(score: number) {
  if (score === 0) return '#64748b';
  if (score < 6) return '#f87171';
  if (score < 8) return '#fbbf24';
  return '#34d399';
}

interface ReviewPoint {
  t: number;
  score: number;
  err: boolean;
  version: string;
}

function collectReviewPoints(customers: CustomerListItem[]): ReviewPoint[] {
  const pts: ReviewPoint[] = [];
  for (const c of customers) {
    for (const pm of c.productMemories) {
      for (const r of pm.reviews) {
        const t = new Date(r.timestamp).getTime();
        if (!Number.isFinite(t)) continue;
        pts.push({
          t,
          score: r.score || 0,
          err: !!r.error,
          version: r.promptVersion || 'unknown',
        });
      }
    }
  }
  return pts.sort((a, b) => a.t - b.t);
}

interface DailyBucket {
  day: string;
  label: string;
  ts: number;
  count: number;
  errors: number;
  avg: number;
}

function aggregateByDay(points: ReviewPoint[]): DailyBucket[] {
  const map = new Map<string, { sum: number; cnt: number; err: number; ts: number }>();
  for (const p of points) {
    const d = new Date(p.t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = map.get(key) || { sum: 0, cnt: 0, err: 0, ts: d.getTime() };
    if (p.err) cur.err += 1;
    else {
      cur.sum += p.score;
      cur.cnt += 1;
    }
    map.set(key, cur);
  }
  const out: DailyBucket[] = [];
  Array.from(map.entries())
    .sort((a, b) => a[1].ts - b[1].ts)
    .forEach(([day, v]) => {
      out.push({
        day,
        label: day.slice(5).replace('-', '/'),
        ts: v.ts,
        count: v.cnt,
        errors: v.err,
        avg: v.cnt > 0 ? v.sum / v.cnt : 0,
      });
    });
  return out;
}

function scoreDistribution(points: ReviewPoint[]) {
  const buckets = [
    { label: '0–2', range: [0, 2], count: 0, color: '#ef4444' },
    { label: '3–4', range: [3, 4], count: 0, color: '#f87171' },
    { label: '5–6', range: [5, 6], count: 0, color: '#fbbf24' },
    { label: '7–8', range: [7, 8], count: 0, color: '#a7f3d0' },
    { label: '9–10', range: [9, 10], count: 0, color: '#34d399' },
  ];
  for (const p of points) {
    if (p.err) continue;
    for (const b of buckets) {
      if (p.score >= b.range[0] && p.score <= b.range[1]) {
        b.count += 1;
        break;
      }
    }
  }
  return buckets;
}

interface TrendVerdict {
  kind: 'up' | 'down' | 'flat' | 'nodata';
  label: string;
  sub: string;
  delta: number;
  latestAvg: number;
  prevAvg: number;
}

function computeVerdict(points: ReviewPoint[]): TrendVerdict {
  const nonErr = points.filter((p) => !p.err);
  if (nonErr.length < 4) {
    return { kind: 'nodata', label: '样本不足', sub: '评估数据量还不够判断走势', delta: 0, latestAvg: 0, prevAvg: 0 };
  }
  const half = Math.floor(nonErr.length / 2);
  const prev = nonErr.slice(0, half);
  const latest = nonErr.slice(half);
  const prevAvg = prev.reduce((a, b) => a + b.score, 0) / prev.length;
  const latestAvg = latest.reduce((a, b) => a + b.score, 0) / latest.length;
  const delta = latestAvg - prevAvg;

  if (delta > 0.25) {
    return {
      kind: 'up',
      label: '持续改善',
      sub: `最近 ${latest.length} 条评估平均分高出前期 ${delta.toFixed(2)} 分`,
      delta,
      latestAvg,
      prevAvg,
    };
  }
  if (delta < -0.25) {
    return {
      kind: 'down',
      label: '有所退步',
      sub: `最近 ${latest.length} 条评估平均分低于前期 ${Math.abs(delta).toFixed(2)} 分`,
      delta,
      latestAvg,
      prevAvg,
    };
  }
  return {
    kind: 'flat',
    label: '保持平稳',
    sub: `前后两段平均分相差仅 ${Math.abs(delta).toFixed(2)} 分`,
    delta,
    latestAvg,
    prevAvg,
  };
}

function TrendArrow({ kind }: { kind: TrendVerdict['kind'] }) {
  if (kind === 'up') {
    return (
      <svg className="verdict-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 17L12 10L17 15L22 10" />
        <path d="M16 10H22V16" />
      </svg>
    );
  }
  if (kind === 'down') {
    return (
      <svg className="verdict-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 7L12 14L17 9L22 14" />
        <path d="M16 14H22V8" />
      </svg>
    );
  }
  if (kind === 'flat') {
    return (
      <svg className="verdict-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 12H20" />
      </svg>
    );
  }
  return (
    <svg className="verdict-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function TrendChart({ buckets }: { buckets: DailyBucket[] }) {
  if (buckets.length === 0) {
    return <div className="trend-empty">暂无足够历史数据绘制趋势图</div>;
  }
  const w = 720;
  const h = 180;
  const padX = 28;
  const padY = 18;
  const maxScore = 10;
  const minScore = 0;
  const xs = (i: number) =>
    buckets.length === 1 ? w / 2 : padX + (i / (buckets.length - 1)) * (w - padX * 2);
  const ys = (s: number) => padY + (1 - (s - minScore) / (maxScore - minScore)) * (h - padY * 2);

  const line = buckets.map((b, i) => `${xs(i).toFixed(1)},${ys(b.avg).toFixed(1)}`).join(' ');
  const areaPath = `M${xs(0).toFixed(1)},${h - padY} L${line.split(' ').join(' L')} L${xs(buckets.length - 1).toFixed(1)},${h - padY} Z`;

  const gridYs = [2, 4, 6, 8, 10];

  return (
    <div className="trend-chart-wrap">
      <svg className="trend-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="trendStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#34d399" />
            <stop offset="50%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#818cf8" />
          </linearGradient>
        </defs>
        {gridYs.map((g) => (
          <g key={g}>
            <line x1={padX} y1={ys(g)} x2={w - padX} y2={ys(g)} stroke="rgba(148,163,184,0.08)" strokeDasharray="2 4" />
            <text x={padX - 6} y={ys(g) + 3} textAnchor="end" fill="#5a6680" fontSize="9" fontFamily="ui-monospace, Menlo">
              {g}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="url(#trendFill)" className="trend-area" />
        <polyline points={line} fill="none" stroke="url(#trendStroke)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="trend-line" />
        {buckets.map((b, i) => (
          <g key={i} className="trend-node" style={{ animationDelay: `${0.5 + i * 0.04}s` }}>
            <circle cx={xs(i)} cy={ys(b.avg)} r="6" fill={scoreColor(b.avg)} opacity="0.25" className="trend-pulse" />
            <circle cx={xs(i)} cy={ys(b.avg)} r="3" fill={scoreColor(b.avg)} stroke="#05070f" strokeWidth="1.5" />
            {(i === 0 || i === buckets.length - 1 || buckets.length <= 8 || i % Math.max(1, Math.floor(buckets.length / 8)) === 0) && (
              <text x={xs(i)} y={h - 4} textAnchor="middle" fill="#5a6680" fontSize="9" fontFamily="ui-monospace, Menlo">
                {b.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

function DistributionChart({ buckets, total }: { buckets: ReturnType<typeof scoreDistribution>; total: number }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  if (total === 0) {
    return <div className="trend-empty">暂无评估分布数据</div>;
  }
  return (
    <div className="dist-grid">
      {buckets.map((b) => {
        const pct = (b.count / max) * 100;
        const sharePct = total > 0 ? (b.count / total) * 100 : 0;
        return (
          <div key={b.label} className="dist-row">
            <div className="dist-range" style={{ color: b.color }}>{b.label}</div>
            <div className="dist-track">
              <div className="dist-fill" style={{ width: `${pct}%`, background: b.color }} />
            </div>
            <div className="dist-count">
              <b>{b.count}</b>
              <span>{sharePct.toFixed(0)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrendSection({ customers }: { customers: CustomerListItem[] }) {
  const points = useMemo(() => collectReviewPoints(customers), [customers]);
  const buckets = useMemo(() => aggregateByDay(points), [points]);
  const dist = useMemo(() => scoreDistribution(points), [points]);
  const verdict = useMemo(() => computeVerdict(points), [points]);
  const nonErrTotal = points.filter((p) => !p.err).length;

  const minScore = buckets.length ? Math.min(...buckets.map((b) => b.avg)) : 0;
  const maxScore = buckets.length ? Math.max(...buckets.map((b) => b.avg)) : 0;
  const peakDay = buckets.length ? buckets.reduce((a, b) => (b.avg > a.avg ? b : a), buckets[0]) : null;
  const worstDay = buckets.length ? buckets.reduce((a, b) => (b.avg < a.avg ? b : a), buckets[0]) : null;

  return (
    <section className="trend-section">
      <h3>进化轨迹 · Is the assistant improving?</h3>
      <div className={`verdict-card kind-${verdict.kind}`}>
        <div className="verdict-icon"><TrendArrow kind={verdict.kind} /></div>
        <div className="verdict-body">
          <div className="verdict-head">
            <span className="verdict-label">{verdict.label}</span>
            {verdict.kind !== 'nodata' && (
              <span className={`verdict-delta ${verdict.kind}`}>
                {verdict.delta >= 0 ? '+' : ''}{verdict.delta.toFixed(2)}
              </span>
            )}
          </div>
          <div className="verdict-sub">{verdict.sub}</div>
          {verdict.kind !== 'nodata' && (
            <div className="verdict-meta">
              <span><em>前期均分</em> {verdict.prevAvg.toFixed(2)}</span>
              <span className="verdict-meta-arrow">→</span>
              <span><em>近期均分</em> <b style={{ color: scoreColor(verdict.latestAvg) }}>{verdict.latestAvg.toFixed(2)}</b></span>
            </div>
          )}
        </div>
        <div className="verdict-stats">
          <div className="vs-item">
            <div className="vs-label">评估样本</div>
            <div className="vs-value">{nonErrTotal}</div>
          </div>
          <div className="vs-item">
            <div className="vs-label">覆盖天数</div>
            <div className="vs-value">{buckets.length}</div>
          </div>
          <div className="vs-item">
            <div className="vs-label">分差</div>
            <div className="vs-value">{buckets.length ? (maxScore - minScore).toFixed(1) : '-'}</div>
          </div>
        </div>
      </div>

      <div className="trend-body">
        <div className="trend-main">
          <div className="trend-title">
            <span>每日平均分走势</span>
            {peakDay && worstDay && buckets.length > 1 && (
              <span className="trend-extremes">
                <em>高点</em> <b style={{ color: '#34d399' }}>{peakDay.avg.toFixed(2)}</b> · {peakDay.label}
                <span className="trend-sep">/</span>
                <em>低点</em> <b style={{ color: '#f87171' }}>{worstDay.avg.toFixed(2)}</b> · {worstDay.label}
              </span>
            )}
          </div>
          <TrendChart buckets={buckets} />
        </div>
        <div className="trend-side">
          <div className="trend-title">分数分布</div>
          <DistributionChart buckets={dist} total={nonErrTotal} />
        </div>
      </div>
    </section>
  );
}

function MiniSpark({ values, color = '#22d3ee' }: { values: number[]; color?: string }) {
  if (!values.length) return null;
  const max = Math.max(...values, 10);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const w = 100;
  const h = 28;
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill="url(#sparkFill)" stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TiltCard({ className = '', style, children }: { className?: string; style?: CSSProperties; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.transform = `perspective(900px) rotateX(${(-y * 6).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg) translateY(-2px)`;
    el.style.setProperty('--tilt-x', `${((x + 0.5) * 100).toFixed(0)}%`);
    el.style.setProperty('--tilt-y', `${((y + 0.5) * 100).toFixed(0)}%`);
  };
  const onLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = '';
  };
  return (
    <div ref={ref} className={`card tilt ${className}`} style={style} onMouseMove={onMove} onMouseLeave={onLeave}>
      <div className="tilt-glow" />
      {children}
    </div>
  );
}

function SummaryCards({ config, summary }: { config?: ConfigInfo; summary?: ReviewSummary }) {
  const current = summary?.promptVersions.find((v) => v.version === config?.promptVersion);
  const avgScore = current?.avgScore ?? 0;
  const lowRate = current && current.count > 0 ? (current.lowScoreCount / current.count) * 100 : 0;
  const errRate = current && current.count > 0 ? (current.errorCount / current.count) * 100 : 0;
  const versionScores = summary?.promptVersions.map((v) => v.avgScore) ?? [];

  return (
    <div className="cards">
      <TiltCard>
        <div className="card-label">当前版本</div>
        <div className="card-value mono">{config?.promptVersion ?? '-'}</div>
        <div className="card-sub">{config?.chatModel} → eval {config?.evaluatorModel}</div>
      </TiltCard>
      <TiltCard>
        <div className="card-label">评价总数</div>
        <div className="card-value">{summary?.totalReviews ?? 0}</div>
        <div className="card-sub">{summary?.totalConversations ?? 0} 个对话</div>
      </TiltCard>
      <TiltCard>
        <div className="card-label">当前版本平均分</div>
        <div className="card-value" style={{ WebkitTextFillColor: scoreColor(avgScore), color: scoreColor(avgScore) }}>
          {avgScore.toFixed(2)}
        </div>
        <div className="card-sub">基于 {current?.count ?? 0} 条评估</div>
        {versionScores.length > 1 && <MiniSpark values={versionScores} color={scoreColor(avgScore)} />}
      </TiltCard>
      <TiltCard>
        <div className="card-label">低分率 / 错误率</div>
        <div className="card-value">
          <span style={{ color: '#f87171' }}>{lowRate.toFixed(0)}%</span>
          <span className="sep"> · </span>
          <span style={{ color: '#a78bfa' }}>{errRate.toFixed(0)}%</span>
        </div>
        <div className="card-sub">分数&lt;6 / 评估失败</div>
      </TiltCard>
    </div>
  );
}

function VersionTable({ summary }: { summary?: ReviewSummary }) {
  if (!summary || summary.promptVersions.length <= 1) return null;
  const maxCount = Math.max(...summary.promptVersions.map((v) => v.count), 1);
  return (
    <section>
      <h3>版本对比 · Prompt Version Benchmark</h3>
      <div className="version-grid">
        {summary.promptVersions.map((v) => {
          const scorePct = Math.max(0, Math.min(100, (v.avgScore / 10) * 100));
          const countPct = (v.count / maxCount) * 100;
          const errPct = v.count > 0 ? (v.errorCount / v.count) * 100 : 0;
          const lowPct = v.count > 0 ? (v.lowScoreCount / v.count) * 100 : 0;
          return (
            <div key={v.version} className="version-row">
              <div className="version-row-head">
                <span className="mono version-tag">{v.version}</span>
                <span className="version-count">{v.count} <em>evals</em></span>
                <span className="version-avg" style={{ color: scoreColor(v.avgScore) }}>
                  {v.avgScore.toFixed(2)}
                </span>
              </div>
              <div className="version-bar">
                <div className="version-bar-fill" style={{ width: `${scorePct}%`, background: `linear-gradient(90deg, ${scoreColor(v.avgScore)}, rgba(34,211,238,0.9))` }} />
                <div className="version-bar-label">avg score</div>
              </div>
              <div className="version-meta">
                <div className="mini-stat">
                  <span className="mini-stat-dot" style={{ background: 'rgba(148,163,184,0.35)' }} />
                  <span>volume</span>
                  <span className="mini-stat-bar"><span style={{ width: `${countPct}%`, background: '#818cf8' }} /></span>
                  <span className="mini-stat-val">{v.count}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat-dot" style={{ background: '#f87171' }} />
                  <span>low (&lt;6)</span>
                  <span className="mini-stat-bar"><span style={{ width: `${lowPct}%`, background: '#f87171' }} /></span>
                  <span className="mini-stat-val">{v.lowScoreCount}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat-dot" style={{ background: '#a78bfa' }} />
                  <span>errors</span>
                  <span className="mini-stat-bar"><span style={{ width: `${errPct}%`, background: '#a78bfa' }} /></span>
                  <span className="mini-stat-val">{v.errorCount}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FrequencyList({ title, items }: { title: string; items: { issue?: string; suggestion?: string; count: number }[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul className="freq">
        {items.slice(0, 10).map((item, i) => (
          <li key={i}>
            <span className="freq-count">{item.count}</span>
            <span className="freq-text">{item.issue ?? item.suggestion}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConversationList({
  customers,
  selected,
  onSelect,
  versionFilter,
}: {
  customers: CustomerListItem[];
  selected?: { customerId: string; conversationId: string };
  onSelect: (c: CustomerListItem, pm: ProductMemory) => void;
  versionFilter?: string;
}) {
  const flat = useMemo(() => {
    const out: { customer: CustomerListItem; pm: ProductMemory; lastReview?: Review }[] = [];
    for (const c of customers) {
      for (const pm of c.productMemories) {
        let reviews = pm.reviews;
        if (versionFilter) {
          reviews = reviews.filter((r) => r.promptVersion === versionFilter);
        }
        if (versionFilter && reviews.length === 0) continue;
        const lastReview = reviews.length ? reviews[reviews.length - 1] : undefined;
        out.push({ customer: c, pm, lastReview });
      }
    }
    return out;
  }, [customers, versionFilter]);

  return (
    <div className="conv-list">
      <div className="conv-list-header">
        <span className="live-dot-mini" /> 会话列表 · <span className="mono">{flat.length}</span>
      </div>
      {flat.map(({ customer, pm, lastReview }, i) => {
        const isSelected = selected?.customerId === customer.customerId && selected?.conversationId === pm.conversationId;
        const score = lastReview?.score ?? 0;
        const isError = !!lastReview?.error;
        const isLow = !isError && lastReview && score > 0 && score < 6;
        return (
          <div
            key={`${customer.customerId}:${pm.conversationId}`}
            className={`conv-item${isSelected ? ' active' : ''}${isError ? ' has-error' : ''}${isLow ? ' has-low' : ''}`}
            onClick={() => onSelect(customer, pm)}
            style={{ animationDelay: `${Math.min(i, 18) * 40}ms` }}
          >
            <div className="conv-row">
              <span className="conv-id">{customer.customerId}</span>
              <span
                className={`conv-score${isError || isLow ? ' pulse' : ''}`}
                style={{ background: scoreColor(score) }}
              >
                {lastReview ? (lastReview.error ? 'ERR' : score) : '-'}
              </span>
            </div>
            <div className="conv-sub">{pm.productId} · <span className="mono">{pm.reviews.length}</span> reviews</div>
            {pm.recentMessages.length > 0 && (
              <div className="conv-preview">
                {pm.recentMessages[pm.recentMessages.length - 1].content.slice(0, 60)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConversationDetail({
  customer,
  pm,
  onReEvaluate,
}: {
  customer?: CustomerListItem;
  pm?: ProductMemory;
  onReEvaluate: () => void;
}) {
  if (!customer || !pm) {
    return <div className="detail-empty">从左侧选取一个会话，查看完整对话链路与评估记录</div>;
  }

  const profile = pm.conversationProfile ?? {};
  return (
    <div className="detail">
      <div className="detail-header">
        <div>
          <h2>{customer.customerId}</h2>
          <div className="muted">
            {pm.productId} · conversationId={pm.conversationId}
          </div>
        </div>
        <button onClick={onReEvaluate}>⟳ 重新评估</button>
      </div>

      {profile && (profile.heightCm || profile.weightKg || profile.rentalPeriod || profile.productIntent) && (
        <div className="profile-card">
          {profile.productIntent?.currentProductText && <span>意向: {profile.productIntent.currentProductText}</span>}
          {profile.heightCm && <span>身高: {profile.heightCm}cm</span>}
          {profile.weightKg && <span>体重: {profile.weightKg}kg</span>}
          {profile.rentalPeriod && (
            <span>档期: {profile.rentalPeriod.startDate ?? '?'} ~ {profile.rentalPeriod.endDate ?? '?'}</span>
          )}
          {profile.orchestration?.stage && <span>阶段: {profile.orchestration.stage}</span>}
          {profile.orderPlacement?.orderNo && <span>订单号: {profile.orderPlacement.orderNo}</span>}
        </div>
      )}

      <h3>对话</h3>
      <div className="messages">
        {pm.recentMessages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-role">
              {m.role === 'user' ? '用户' : '客服'}
              {m.intent && (
                <span className={`intent-chip intent-${m.intent}`} title="意图分类器 tag">
                  {m.intent}
                </span>
              )}
            </div>
            <div className="msg-content">{m.content}</div>
          </div>
        ))}
      </div>

      <h3>评估历史（{pm.reviews.length}）</h3>
      <div className="reviews">
        {pm.reviews.slice().reverse().map((r, i) => (
          <div key={i} className="review">
            <div className="review-head">
              <span className="score-badge" style={{ background: scoreColor(r.score) }}>
                {r.error ? 'ERR' : r.score}
              </span>
              <span className="mono">{r.promptVersion ?? '-'}</span>
              <span className="muted">{new Date(r.timestamp).toLocaleString()}</span>
              <span className="muted">{r.source}</span>
            </div>
            {r.error && <div className="review-error">{r.error}</div>}
            {r.evaluatedReply && (
              <div className="review-block">
                <div className="review-label">被评估的回复</div>
                <div className="review-text">{r.evaluatedReply}</div>
              </div>
            )}
            {r.issues.length > 0 && (
              <div className="review-block">
                <div className="review-label">问题</div>
                <ul>{r.issues.map((issue, j) => <li key={j}>{issue}</li>)}</ul>
              </div>
            )}
            {r.suggestions.length > 0 && (
              <div className="review-block">
                <div className="review-label">建议</div>
                <ul>{r.suggestions.map((s, j) => <li key={j}>{s}</li>)}</ul>
              </div>
            )}
            {r.suggestedReply && (
              <div className="review-block suggested">
                <div className="review-label">◆ 建议改写</div>
                <div className="review-text">{r.suggestedReply}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// 评测中枢单页应用（知识库后台已移除，dashboard 只保留 eval 观测能力）
export default function App() {
  const { data: config } = useAsync(fetchConfig, []);
  const { data: summary, reload: reloadSummary, lastUpdated: summaryUpdated, loading: summaryLoading } = useAsync(fetchSummary, []);
  const { data: customersResp, reload: reloadCustomers, loading: customersLoading } = useAsync(() => fetchCustomers(1, 200), []);
  const [selected, setSelected] = useState<{ customerId: string; conversationId: string } | undefined>();
  const [versionFilter, setVersionFilter] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const customers = customersResp?.customers ?? [];
  const selectedCustomer = customers.find((c) => c.customerId === selected?.customerId);
  const selectedPm = selectedCustomer?.productMemories.find((pm) => pm.conversationId === selected?.conversationId);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([reloadSummary(), reloadCustomers()]);
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  };

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(doRefresh, 20000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  const onReEvaluate = async () => {
    if (!selectedPm || !selectedCustomer) return;
    try {
      await triggerReEvaluate(selectedCustomer.customerId, selectedPm.productId, selectedPm.conversationId);
      await Promise.all([reloadCustomers(), reloadSummary()]);
    } catch (e) {
      alert(`重评失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const isLoading = refreshing || summaryLoading || customersLoading;

  return (
    <div className="app">
      <header className="app-header">
        <h1>NEXUS · 智能客服评测中枢</h1>
        <div className="app-header-right">
          <nav className="top-nav" aria-label="主导航">
            <a className="top-nav-item" href="/" title="对话推理台">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              对话推理
            </a>
            <span className="top-nav-item active" aria-current="page">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3v18h18" />
                <path d="M7 15l4-4 4 4 5-5" />
              </svg>
              评测中枢
            </span>
          </nav>
          <div className="live-status">
            <span className={`live-dot ${autoRefresh ? 'on' : 'off'}`} />
            <span className="live-text">
              {autoRefresh ? 'LIVE · 自动刷新' : 'PAUSED · 手动刷新'}
            </span>
            <span className="live-sep">·</span>
            <span className="live-updated">{formatRelative(summaryUpdated)}</span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? '点击暂停自动刷新' : '点击开启自动刷新'}
          >
            {autoRefresh ? '⏸ 暂停' : '▶ 实时'}
          </button>
          <button onClick={doRefresh} className={isLoading ? 'btn-spin' : ''}>
            <span className="refresh-icon">⟳</span>
            <span>{isLoading ? '同步中' : '刷新数据'}</span>
          </button>
        </div>
      </header>

      <SummaryCards config={config} summary={summary} />
      <TrendSection customers={customers} />
      <VersionTable summary={summary} />

      {summary && summary.promptVersions.length > 1 && (
        <div className="filter-bar">
          <label>过滤 · Filter</label>
          <div className="chip-row">
            <button
              type="button"
              className={`chip ${versionFilter === '' ? 'active' : ''}`}
              onClick={() => setVersionFilter('')}
            >
              全部<em>{summary.totalReviews}</em>
            </button>
            {summary.promptVersions.map((v) => (
              <button
                key={v.version}
                type="button"
                className={`chip ${versionFilter === v.version ? 'active' : ''}`}
                onClick={() => setVersionFilter(v.version)}
              >
                <span className="mono">{v.version}</span><em>{v.count}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="two-col">
        <div className="sidebar">
          <ConversationList
            customers={customers}
            selected={selected}
            onSelect={(c, pm) => setSelected({ customerId: c.customerId, conversationId: pm.conversationId })}
            versionFilter={versionFilter || undefined}
          />
        </div>
        <div className="main">
          <ConversationDetail customer={selectedCustomer} pm={selectedPm} onReEvaluate={onReEvaluate} />
        </div>
      </div>

      <div className="two-col">
        <FrequencyList title="高频问题 Top 10" items={summary?.topIssues ?? []} />
        <FrequencyList title="高频建议 Top 10" items={summary?.topSuggestions ?? []} />
      </div>
    </div>
  );
}
