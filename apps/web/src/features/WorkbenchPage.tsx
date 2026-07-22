import { useState } from 'react'
import { Check, Send, Sparkles } from 'lucide-react'
import {
  ArtifactApprovalSchema,
  ArtifactListSchema,
  RunResponseSchema,
  type Artifact,
  type RunResponse,
} from '@/lib/contracts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

const API_BASE_URL = '/api/chatty'

const DEFAULT_TASK =
  '根据本地演示资料，生成一份高精地图产业研究简报，并改写成小红书内容草稿。明确未知项，不要补造实时市场数据。'

const statusLabels: Record<Artifact['status'], string> = {
  draft: '草稿',
  review_failed: '复核失败',
  review_pending: '待人工批准',
  approved: '已批准',
  exported: '已导出',
}

const channelLabels = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  wechat: '公众号',
} as const

type Operation =
  | { kind: 'idle' }
  | { kind: 'run' }
  | { kind: 'approve'; artifactId: string }
  | { kind: 'export'; artifactId: string }

function responseError(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const detail = (payload as Record<string, unknown>).detail
    if (typeof detail === 'string') return detail
  }
  return '请求失败'
}

async function requestJson<T>(
  input: string,
  schema: { parse(value: unknown): T },
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init)
  const text = await response.text()
  let payload: unknown
  try {
    payload = text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    throw new Error(
      response.ok
        ? '服务返回了无法读取的数据，请重试'
        : `请求失败（HTTP ${response.status}）`,
    )
  }
  if (!response.ok) throw new Error(responseError(payload))
  try {
    return schema.parse(payload)
  } catch {
    throw new Error('服务返回了不完整的数据，请重试')
  }
}

export default function WorkbenchPage() {
  const [task, setTask] = useState(DEFAULT_TASK)
  const [sessionId, setSessionId] = useState<string>()
  const [run, setRun] = useState<RunResponse>()
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [operation, setOperation] = useState<Operation>({ kind: 'idle' })
  const [taskError, setTaskError] = useState<string>()
  const [artifactError, setArtifactError] = useState<string>()
  const busy = operation.kind !== 'idle'

  async function loadArtifacts(currentSessionId: string) {
    setArtifacts(
      await requestJson(
        `${API_BASE_URL}/artifacts?session_id=${encodeURIComponent(currentSessionId)}`,
        ArtifactListSchema,
      ),
    )
  }

  async function runAgent(
    message = task,
    nextOperation: Operation = { kind: 'run' },
  ) {
    const input = message.trim()
    if (!input || busy) return
    setOperation(nextOperation)
    if (nextOperation.kind === 'run') setTaskError(undefined)
    else setArtifactError(undefined)
    try {
      const nextRun = await requestJson(
        `${API_BASE_URL}/runs`,
        RunResponseSchema,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: input, session_id: sessionId }),
        },
      )
      setRun(nextRun)
      setSessionId(nextRun.session_id)
      await loadArtifacts(nextRun.session_id)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '请求失败'
      if (nextOperation.kind === 'run') setTaskError(message)
      else setArtifactError(message)
    } finally {
      setOperation({ kind: 'idle' })
    }
  }

  async function approveArtifact(artifact: Artifact) {
    setOperation({ kind: 'approve', artifactId: artifact.id })
    setArtifactError(undefined)
    try {
      await requestJson(
        `${API_BASE_URL}/artifacts/${encodeURIComponent(artifact.id)}/approve`,
        ArtifactApprovalSchema,
        { method: 'POST' },
      )
      await loadArtifacts(artifact.session_id)
    } catch (caught) {
      setArtifactError(caught instanceof Error ? caught.message : '批准失败')
    } finally {
      setOperation({ kind: 'idle' })
    }
  }

  return (
    <main
      id="main-content"
      className="h-dvh overflow-y-auto bg-background px-4 py-6 text-foreground md:px-8"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <Badge className="w-fit" variant="secondary">
            单 Agent · 本地演示
          </Badge>
          <h1 className="text-3xl font-semibold tracking-tight">
            Agent 内容工作台
          </h1>
          <p className="max-w-3xl text-muted-foreground">
            从可信资料生成可追溯研究与渠道草稿；批准由你完成，分发仅模拟到
            sandbox。
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>给 Agent 一个任务</h2>
                </CardTitle>
                <CardDescription>
                  Model 自主选择固定 Tools，Harness 负责来源、状态与完成验证。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field data-invalid={taskError ? true : undefined}>
                    <FieldLabel htmlFor="agent-task">任务描述</FieldLabel>
                    <Textarea
                      id="agent-task"
                      aria-invalid={taskError ? true : undefined}
                      className="min-h-36 resize-y"
                      value={task}
                      onChange={(event) => setTask(event.target.value)}
                    />
                    <FieldDescription>
                      Demo 使用本地
                      Knowledge，不提供实时行情、平台发布或投资建议。
                    </FieldDescription>
                    <FieldError>{taskError}</FieldError>
                  </Field>
                </FieldGroup>
              </CardContent>
              <CardFooter className="justify-between gap-3">
                <span className="text-sm text-muted-foreground">
                  {sessionId ? `Session ${sessionId}` : '新 Session'}
                </span>
                <Button
                  disabled={busy || !task.trim()}
                  onClick={() => void runAgent()}
                >
                  {operation.kind === 'run' ? (
                    <Sparkles data-icon="inline-start" aria-hidden="true" />
                  ) : (
                    <Send data-icon="inline-start" aria-hidden="true" />
                  )}
                  {operation.kind === 'run' ? '运行中' : '运行 Agent'}
                </Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Agent 结果</h2>
                </CardTitle>
                <CardDescription>
                  最终回复之外，同时保留 Trace 与 Harness 完成证据。
                </CardDescription>
              </CardHeader>
              <CardContent
                aria-busy={operation.kind === 'run'}
                aria-live="polite"
                className="flex flex-col gap-4"
              >
                {run ? (
                  <>
                    <p className="whitespace-pre-wrap leading-7">{run.reply}</p>
                    <dl className="grid gap-3 rounded-lg bg-muted p-4 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">Trace</dt>
                        <dd className="break-all font-mono">{run.trace_id}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">完成证据</dt>
                        <dd className="break-all font-mono">
                          {run.completion_evidence ?? '无'}
                        </dd>
                      </div>
                    </dl>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    尚未运行。你会在这里看到 Agent 回复和可验证证据。
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Artifacts</h2>
              </CardTitle>
              <CardDescription>
                研究和内容是有 lineage 的结构化产物，不是散落的聊天文本。
              </CardDescription>
            </CardHeader>
            <CardContent
              aria-busy={
                operation.kind === 'approve' || operation.kind === 'export'
              }
              aria-label="Artifacts"
              aria-live="polite"
              className="flex flex-col gap-4"
              role="region"
            >
              {artifactError ? (
                <p className="text-sm text-destructive" role="alert">
                  {artifactError}
                </p>
              ) : null}
              {artifacts.length === 0 ? (
                <p className="text-muted-foreground">
                  完成研究任务后，产物会出现在这里。
                </p>
              ) : (
                artifacts.map((artifact) => (
                  <article
                    className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
                    key={artifact.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {artifact.kind === 'research' ? '研究简报' : '内容包'}
                        </span>
                        <h3 className="break-words font-medium">
                          {artifact.title}
                        </h3>
                      </div>
                      <Badge
                        className="shrink-0"
                        variant={
                          artifact.status === 'review_failed'
                            ? 'destructive'
                            : 'outline'
                        }
                      >
                        {statusLabels[artifact.status]}
                      </Badge>
                    </div>

                    {artifact.kind === 'research' ? (
                      <div className="flex flex-col gap-2 text-sm">
                        <p>{artifact.summary}</p>
                        <p className="text-muted-foreground">
                          {artifact.claims.length} Claims ·{' '}
                          {artifact.unknowns.length} 未知项
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {artifact.channels.map((channel) => (
                          <section
                            className="rounded-md bg-muted p-3 text-sm"
                            key={channel.channel}
                          >
                            <strong>{channelLabels[channel.channel]}</strong>
                            <h4 className="mt-1 break-words font-medium">
                              {channel.title}
                            </h4>
                            <p className="mt-2 break-words whitespace-pre-wrap text-muted-foreground">
                              {channel.body}
                            </p>
                          </section>
                        ))}
                      </div>
                    )}

                    {artifact.status === 'review_pending' ? (
                      <Button
                        aria-label={`批准${artifact.kind === 'content' ? '内容包' : '研究简报'}`}
                        disabled={busy}
                        size="sm"
                        onClick={() => void approveArtifact(artifact)}
                      >
                        <Check data-icon="inline-start" aria-hidden="true" />
                        {operation.kind === 'approve' &&
                        operation.artifactId === artifact.id
                          ? '批准中'
                          : '人工批准'}
                      </Button>
                    ) : null}
                    {artifact.status === 'approved' ? (
                      <Button
                        disabled={busy}
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void runAgent(
                            `请将已批准的 Artifact ${artifact.id} 导出到 sandbox，并返回 delivery receipt。`,
                            { kind: 'export', artifactId: artifact.id },
                          )
                        }
                      >
                        {operation.kind === 'export' &&
                        operation.artifactId === artifact.id
                          ? '导出中'
                          : '请求沙箱导出'}
                      </Button>
                    ) : null}
                  </article>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
