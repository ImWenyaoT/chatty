# Rental RAG Service

> **ARCHIVED（legacy lane，冻结）**：权威架构见根目录 [docs/architecture.md](../docs/architecture.md)。
> 本目录仅为金标评测链（`pnpm eval` + `tests/golden/`）保活，按 RW-1 计划最终从 main 删除。
> 原 Vite dashboard 子包已于 2026-07 删除（apps/web 的 `/dashboard` 重建了同类功能）。

面向租赁服装客服场景的智能客服服务。**核心机制不是"LLM 自由发挥"**，而是 `Action 路由 + 模板渲染 + LLM 兜底` 的混合架构。已配套评测闭环（自动评分、版本对比、金标回归）。

> 读完这份 README 你能：本地跑起来 / 改 prompt 和业务规则 / 跑回归测试。
> 想理解内部机制，进一步看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 1. 当前能力

**对话能力**
- 锁商品 → 收档期 → 收身高体重 → 算尺码 → 复核 → 引导下单 的 6 阶段流程
- 关键词 fast-path 命中（greet/repair/价格/物流/已下单/...）走确定性模板，不进 LLM
- 流程外的事实问答走 RAG + LLM tool-call 分类
- 自动结构化抽取：身高、体重、租赁档期、意向商品
- 主动追问次数上限，防止骚扰

**评测能力**
- 每条客服回复异步打分（默认 `gpt-5.2`，可独立配置 `EVALUATOR_MODEL`）
- 评分输出 `score / issues / suggestions / suggestedReply`
- 评估失败落 error review 不重试
- 每条 review 自带 `promptVersion` + `chatModel` + `evaluatorModel` 标签，方便版本对比
- 金标回归 `pnpm eval` + 版本对比 `--baseline`

**配置化**
- 所有 prompt 和业务规则在 `config/prompts/<version>.yaml` 和 `config/catalog.yaml`
- 改 YAML 不需要改代码，启动时自动算 `promptVersion` 哈希
- `PROMPT_VERSION=v2 pnpm dev` 一键切版本

---

## 2. 项目结构

```
rag-service/
├── config/
│   ├── prompts/v1.yaml          # stylist + supplement + evaluator + factExtractor prompts
│   └── catalog.yaml             # 商品价格 + 尺码规则
├── data/
│   ├── memory-store.json        # 会话记忆持久化（运行时自动写入）
│   └── local-vectors.json       # Qdrant 不可用时的本地向量备份
├── docs/                        # RAG 知识源（pnpm ingest 入库）
│   ├── rules/
│   ├── history/
│   └── products/
├── public/
│   └── test.html                # 手动测试页（手写 HTML）
├── scripts/
│   ├── ingest.ts                # 知识入库
│   ├── eval.ts                  # 金标回归运行器
│   └── dev-setup.sh
├── src/
│   ├── server.ts                # Fastify HTTP 入口
│   ├── config.ts                # 环境变量
│   ├── openai.ts                # OpenAI 客户端
│   ├── prompts-loader.ts        # YAML 加载 + 版本哈希
│   ├── memory-store.ts          # 记忆 + 串行化锁 + 异步评估调度
│   ├── conversation-orchestrator.ts  # stage / nextAction 状态机
│   ├── chunking.ts              # 文档分块
│   ├── qdrant.ts / local-store.ts  # 向量库（双端兼容）
│   ├── availability-service.ts  # 库存档期查询占位
│   ├── types.ts                 # 全局类型
│   ├── parsers/
│   │   ├── measurements.ts      # 身高体重抽取（共享）
│   │   └── date.ts              # 日期归一（共享）
│   ├── rag/
│   │   ├── intents.ts           # 关键词意图判别（isXxxQuestion）
│   │   ├── actions.ts           # Action discriminated union
│   │   ├── templates.ts         # renderAction(action)：所有客服话术模板
│   │   └── action-picker.ts     # selectAction：fast-path + LLM tool-call
│   └── rag.ts                   # 薄控制器 + RAG 检索 + 评估器
└── tests/
    ├── golden/*.yaml            # 金标场景（每次 eval 必跑）
    └── reports/*.json           # baseline 对比报告
```

---

## 3. 运行前提

- Node.js 22+
- Docker（可选，用于启动 Qdrant；不装也能跑，回退到本地向量）
- 一个 OpenAI 兼容接口（`OPENAI_BASE_URL` 指向你的 endpoint）

---

## 4. 环境变量

复制 `.env.example` 为 `.env`，至少填：

```env
OPENAI_API_KEY=your_key
OPENAI_BASE_URL=https://your-endpoint/v1
CHAT_MODEL=gpt-5.2
EVALUATOR_MODEL=gpt-5.2          # 可独立指定评估模型
EMBEDDING_MODEL=text-embedding-3-large
PROMPT_VERSION=v1                 # 对应 config/prompts/<version>.yaml
PORT=3001
TOP_K=5
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=rental_knowledge
```

可选：

```env
LOCAL_VECTOR_STORE_PATH=data/local-vectors.json
MEMORY_STORE_PATH=data/memory-store.json
VECTOR_SIZE=3072                  # text-embedding-3-large 用 3072，3-small 用 1536
```

---

## 5. 安装与启动

```bash
pnpm install                      # 在仓库根目录安装所有 workspace 依赖
cd rag-service

pnpm qdrant:start                 # 启动 Qdrant（可选）
pnpm ingest                       # 首次或更新知识后入库
pnpm dev                          # 启动 Fastify（tsx watch）
```

打开：

| URL | 用途 |
|---|---|
| http://127.0.0.1:3001/ | 手动测试页 |
| http://127.0.0.1:3001/health | 健康检查 |
| http://127.0.0.1:3001/config/info | 当前 promptVersion + 模型 |

生产构建：`pnpm build` → `node dist/src/server.js`

---

## 6. 知识录入规则

知识目录：`docs/rules` / `docs/history` / `docs/products`

支持文件类型：`.csv` `.md` `.txt` `.json`

录入要点：
- **QA 必须 CSV，且表头严格为 `question,answer`**（其它表头会被当成普通文本）
- 规则类内容写成短条目，避免一段塞多个规则
- 商品类要包含：名称、款式、适用场景、尺码建议、价格、注意事项

每次改完 `docs/` 重新跑 `pnpm ingest`，覆盖入库。

---

## 7. API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/config/info` | 当前 promptVersion / 模型 / 商品目录 |
| GET | `/` | 手动测试 HTML |
| GET | `/history` | 旧 React Dashboard 路由（dashboard 子包已删除，无构建产物时 404） |
| POST | `/chat` | 对话主入口 |
| GET | `/memory/:customerId?productId=` | 单客户记忆 |
| GET | `/memories/all?page=&limit=` | 所有客户记忆（Dashboard 用） |
| GET | `/reviews/summary` | 按版本聚合的评分汇总（Dashboard 用） |
| POST | `/reviews/evaluate` | 重新评估某条会话的最新客服回复 |
| POST | `/reviews/add` | 人工补打分 |
| POST | `/orders/place` | 标记客户已下单（触发 post_order_followup） |
| POST | `/availability/check` | 当前为占位，返回 hardcoded 可用 |

`/chat` 请求/响应：

```json
// POST /chat
{
  "customerId": "customer-001",
  "productId": "SUIT-001",
  "conversationId": "customer-001:SUIT-001",
  "question": "5月8号租一天 黑色双排扣 179cm 70kg",
  "sessionContext": {},
  "stylistPrompt": "可选，覆盖默认 stylist"
}

// 响应
{
  "answer": "...",
  "action": "guide_order",          // 本轮命中的 Action 类型
  "references": [...],
  "handoff": { "needed": false },
  "memory": { "...": "..." }
}
```

---

## 8. 配置驱动的迭代工作流

### 8.1 改 prompt（最常见）

直接编辑 `config/prompts/v1.yaml`：

| 字段 | 用途 |
|---|---|
| `stylistPrompt` | 店员人设和说话风格 |
| `systemSupplement` | **硬规则**（最高优先级，注入到 system prompt 最前面） |
| `evaluatorSystemPrompt` + `evaluatorUserTemplate` | 评估器 prompt |
| `factExtractorSystemPrompt` | 结构化事实抽取器 prompt |

修改后**重启服务**（`tsx watch` 不监控 YAML）。`promptVersion` 哈希自动变化。

### 8.2 改业务规则（商品/价格/尺码）

编辑 `config/catalog.yaml`：

```yaml
products:
  - id: SUIT-001
    name: 黑色双排扣西装
    dailyPrice: 199
    renewalDailyPrice: 99.5
    shippingPolicy: 寄出包邮，新疆、西藏等偏远地区除外
    pricingNote: 第一天全价，续租半价，在途不算租期

sizeRules:
  - { minHeight: 175, maxHeight: 181, minWeight: 66, maxWeight: 80, size: L, confidence: high }
sizeFallback:
  size: 尺码待人工确认
  confidence: low
```

### 8.3 加新版本 + 对比

```bash
cp config/prompts/v1.yaml config/prompts/v2.yaml
vim config/prompts/v2.yaml      # 改你想试的内容

pnpm eval -- --save v1-baseline   # 先用 v1 跑 baseline（如果还没存）

PROMPT_VERSION=v2 pnpm eval -- --baseline v1-baseline
# 输出每个金标场景的 Δ 分数，PASS/FAIL 变化
```

### 8.4 改客服话术

如果不是规则问题，只是话术不顺口，编辑 `src/rag/templates.ts`，对应 `Action.kind` 的 case 分支。模板是纯函数，没有副作用，改完重启就生效。

### 8.5 加新 Action

如果发现某些场景没有对应的回复类型：

1. 在 `src/rag/actions.ts` 加一个新的 Action variant
2. 在 `src/rag/templates.ts` 的 switch 里加 case
3. 在 `src/rag/action-picker.ts` 的 `selectAction` 加触发规则
4. 跑 `pnpm exec tsc -p tsconfig.json --noEmit` 验证

---

## 9. 评测闭环

```
用户消息
   ↓
答案生成 (action + 模板)
   ↓
立即返回给用户  →  保存消息到 memory（同步）
                      ↓
               异步评估器（gpt-5.2 + JSON Schema）
                      ↓
               生成 review { score, issues, suggestions, suggestedReply, promptVersion, chatModel, evaluatorModel, error? }
                      ↓
               追加到 productMemory.reviews（走全局锁，不与 /chat 抢写）
```

评分数据的可视化入口在 apps/web 的 `/dashboard`（本目录原 React Dashboard 已删除）。

**金标回归**：

```bash
pnpm eval                        # 跑全部场景
pnpm eval -- --filter happy      # 只跑名字含 "happy" 的
pnpm eval -- --save v1-base      # 存当前结果
pnpm eval -- --baseline v1-base  # 对比当前 vs baseline
```

金标 YAML 在 `tests/golden/`，写法见现有 5 个示例文件，断言支持：

| 字段 | 含义 |
|---|---|
| `contains: [...]` | 答案必须包含 |
| `notContains: [...]` | 答案不能包含 |
| `stage: xxx` 或 `stageIn: [...]` | 该步后 orchestration.stage 校验 |
| `minScore: 7` | 该步评分门槛 |
| `profile: { heightCm: 180, rentalPeriod: { startDate: "*" } }` | profile 字段断言（`*` = 存在即可） |

测试自动跑在隔离的 `tests/.tmp/memory-store.json`，不会污染真实数据。

---

## 11. Tool-calling 重构遗留事项

> Step 2 重构中做过的简化 / 待办项。**A–F + H 部分** 已于 2026-04 补完，剩 **G / H 剩余部分** 待验证。

### 11.1 已补完 ✅

| 项 | 内容 | 修复位置 |
|---|---|---|
| A | post_order_delivery 恢复日期推算 + diffDays<2 触发人工 | `action-picker.ts: evaluateDeliveryUrgency` + `templates.ts: parseIsoDate/formatMonthDay` |
| B | deriveNextProfile 补齐 availabilityCheck 推断 | `action-picker.ts: deriveNextProfile` |
| C | answer_faq + orchestrationFollowUp 内容去重 | `templates.ts: case 'answer_faq'` |
| E | 事实抽取 LLM 调用去重（答问 → 记忆写入透传） | `rag.ts` 返回 `extractedFacts` → `server.ts` 透传 → `memory-store.ts: preExtractedFacts` |
| F | 金标断言新增 `expect.action` / `expect.actionIn` | `scripts/eval.ts` + 全部现有 golden YAML |
| H (部分) | 新增金标场景覆盖更多 Action | `tests/golden/{rental-period-provide,current-link,all-in-one,post-order-delivery}.yaml` |

### 11.2 仍待做

**G. LLM 分类器 4 模式准确率未验证**
- `callClassifier` 用 `gpt-5.2` 做 follow_flow / answer_faq / small_talk / handoff 四选一
- 没有标注数据集，实际准确率未知，可能存在误分类
- 修复路径：线上跑一段时间 → 收集 `(question, action)` 样本 → 人工复核 → 混淆矩阵 → 针对性改 `classifierSystemPrompt` 或加 fast-path

**H. 剩余 Action 的真实话术 review**
- `recall_body_ambiguous`、`handoff`、`check_availability`、`confirm_size` 空 size 分支等还没在真实对话中跑过
- 修复路径：手动触发每一个 Action 看输出，必要时调 `templates.ts` 里对应 case 的话术

---

## 12. 已知限制 / 注意事项

- **YAML 修改不会热加载**，需要重启服务（`tsx watch` 只监控 `.ts`）
- **memory-store 是单进程文件锁**，多进程部署需要换成数据库或文件锁
- **`/availability/check`** 是占位实现，永远返回 `available: true`，真接库存系统时改 `src/availability-service.ts`
- **`scheduleReview` 的 timestamp 是评估完成时间**，不是对话发生时间。如果要做严格的"对话→评分"时间序列分析，需要改成 chat 时的 timestamp
- **Memory 历史脏数据**会污染测试。如果遇到行为异常，删除对应客户的 productMemories 重测
- **embedding 维度变了要重新 ingest**：`text-embedding-3-large=3072`，`text-embedding-3-small=1536`，切换模型后 Qdrant collection 要重建

---

## 14. 接力问题速查

| 问题 | 看哪 |
|---|---|
| 客服又问了不该问的（围度/常穿码等） | `config/prompts/v1.yaml` 的 `systemSupplement` 硬规则 + `src/rag/action-picker.ts` 的 `classifierSystemPrompt` |
| 想加一个新的客服回复类型 | `actions.ts` + `templates.ts` + `action-picker.ts`（三处都改） |
| 评估器评分异常偏高/偏低 | `evaluatorSystemPrompt` 改、或换 `EVALUATOR_MODEL` |
| 评分聚合数据不对 | 看 `/reviews/summary` 和 `/memories/all` 的原始 JSON；`memory-store.ts` 的 `getReviewSummary` 是聚合源 |
| 流程 stage 卡在某一步推不动 | `conversation-orchestrator.ts` 看 `decideStage` 和 `decideAction`；`buildPendingSlots` 决定缺什么 |
| 知识检索不命中 | 看 `docs/` 内容是否合理分块；`src/chunking.ts` 决定分块策略 |
| 下单后又被推回前面 stage | `src/rag/action-picker.ts` 的 post-order branch，确认逻辑没漏 |

进一步细节看 [ARCHITECTURE.md](./ARCHITECTURE.md)。
