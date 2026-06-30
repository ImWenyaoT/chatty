# Architecture

读这份之前先读 [README.md](./README.md)。这里只讲内部机制和扩展点。

---

## 1. 一次 `/chat` 请求的全链路

```
HTTP POST /chat
   │
   ↓
server.ts: 校验 zod schema
   │
   ↓
rag.ts: answerQuestion(body)
   ├── getCustomerMemory + getProductMemory   ← memory-store.ts
   ├── searchKnowledge(question)              ← embedText + Qdrant/local
   ├── extractStructuredConversationFacts     ← LLM 抽 rentalPeriod + productIntent
   ├── extractHeightWeightFromText            ← 正则抽身高体重（parsers/measurements）
   ├── 构造 ActionContext
   └── selectAction(ctx)                      ← rag/action-picker.ts
       ├── Step 1: 13 条规则 fast-path（无 LLM 调用）
       │   命中 → 返回 Action
       └── Step 2: LLM tool-call 分类器
           4 模式：follow_flow / answer_faq / small_talk / handoff
           ↓
           follow_flow → deriveNextProfile + orchestrator → nextAction → Action
           其它 → 直接转 Action
   │
   ↓
renderAction(action)                          ← rag/templates.ts （纯函数）
   │
   ↓
sanitizeAnswerText(text)
   │
   ↓
返回 { answer, action, references, handoff }
   │
   ↓
server.ts: appendConversationMemory(...)      ← 保存消息（带锁）
   ├── 再做一次 fact extract（冗余但低风险）
   ├── 合并 profile + 跑 orchestrator + 写盘
   └── scheduleReview(...) fire-and-forget    ← 异步评估
                                                  ↓
                                              evaluateCustomerServiceReply (LLM)
                                                  ↓
                                              拿到锁 → 追加 review → 写盘
   │
   ↓
HTTP 响应给客户端
```

---

## 2. Action 设计

### 2.1 Action 是 Discriminated Union

定义在 `src/rag/actions.ts`：

```ts
type Action =
  | { kind: 'greet' }
  | { kind: 'repair'; hint?: string }
  | { kind: 'rental_howto'; ... }
  | { kind: 'current_link_confirm'; ... }
  | { kind: 'recall_body_empty' }
  | { kind: 'recall_body_ambiguous'; labels: string[] }
  | { kind: 'post_order_delivery'; ... }
  | { kind: 'post_order_followup' }
  | { kind: 'quote_price'; ... }
  | { kind: 'ask_product' }
  | { kind: 'ask_period'; productText? }
  | { kind: 'ask_body'; startDate?, endDate? }
  | { kind: 'ack_body_measurement'; ... }
  | { kind: 'ack_rental_period'; ... }
  | { kind: 'confirm_size'; size: string; note?: string }
  | { kind: 'confirm_review'; productText?, startDate?, endDate?, size? }
  | { kind: 'guide_order'; size?, startDate?, endDate?, dailyPrice? }
  | { kind: 'check_availability' }
  | { kind: 'answer_faq'; text: string; orchestrationFollowUp? }
  | { kind: 'small_talk'; text: string }
  | { kind: 'handoff'; text: string; reason: string };
```

### 2.2 三类 Action

| 类型 | 来源 | 文本 |
|---|---|---|
| 快速路径 | 规则匹配 | 模板渲染（确定性） |
| 流程推进 | orchestrator nextAction | 模板渲染（确定性） |
| 开放通道 | LLM tool-call | LLM 写文本，但限定模式 + 短长度 |

### 2.3 为什么这样设计

- LLM 物理上**没有**"询问围度"这种 Action，所以无论 prompt 怎么写它都问不出来
- `answer_faq` 是唯一让 LLM 自由生成"答案文本"的通道，但内容受 references 约束
- `small_talk` 是 3-10 字的极短回应，不可能塞进违规追问
- `handoff` 用固定话术
- 90% 路径不调主 LLM，速度快 + 成本低

---

## 3. selectAction 路由优先级（src/rag/action-picker.ts）

按从上到下顺序，先命中先用：

| # | 触发条件 | 输出 Action |
|---|---|---|
| 1 | `isRepairQuestion` | `repair` |
| 2 | 已下单 + `isDeliveryQuestion` | `post_order_delivery` |
| 3 | `isGreetingQuestion` | `greet` |
| 4 | 已下单 + 非价格/howto | `post_order_followup` |
| 5 | `isGenericRentIntent` 且无商品 | `ask_product` |
| 6 | `isRentalHowToQuestion` | `rental_howto` |
| 7 | `isCurrentLinkProductQuestion` 且有商品 | `current_link_confirm` |
| 8 | `isBodyMeasurementRecallQuestion` + 0/多档案 | `recall_body_empty` / `recall_body_ambiguous` |
| 9 | `isPriceQuestion` | `quote_price` + nextPrompt |
| 10 | 提供新事实（身高/体重/档期） | `deriveNextProfile` → orchestrator → Action |
| 11 | `isSimpleConfirmation` + 上一条客服在确认资料 | 推下一步 |
| 12 | `isOrderQuestion` + readyToOrder | `guide_order` |
| 13 | （兜底）LLM 分类器 | follow_flow / faq / small_talk / handoff |

### 3.1 Step 13 的 LLM 分类器

`src/rag/action-picker.ts` 里 `callClassifier()`：

- 模型：`config.chatModel`（`mimo-2.5`）
- temperature 0.1
- 工具：单个 `decide_reply` function，必须调用
- 参数：`mode` (enum) + 可选 `faqAnswer` / `smallTalkText` / `handoffReason`
- system prompt 说明：
  - 4 个 mode 各自的判定标准
  - 三项齐全时必须 follow_flow
  - faqAnswer 不许追问围度/常穿码

### 3.2 deriveNextProfile（关键）

当用户**一句话给齐多项资料**时（"5月9号到10号 黑色西装 175cm 56kg"），现有 orchestrator 还没看到这些事实。`deriveNextProfile`：

1. 把 `providedBody` + `providedPeriod` + `effectiveProductText` 假装写进 profile
2. 用 catalog.yaml 算尺码
3. 用本地化的 `orderReadiness` 替代异步推导
4. 跑 `deriveConversationOrchestration`
5. 返回新 profile

这样这一轮就能直接走 `guide_order` 而不是绕一圈让客户重复说一次。

---

## 4. ConversationOrchestrator（src/conversation-orchestrator.ts）

### 4.1 stage 枚举

| stage | 含义 |
|---|---|
| `intent_discovery` | 用户意图未知 |
| `product_locking` | 已表达租意，未锁定具体商品 |
| `schedule_collecting` | 已锁商品，未给档期 |
| `body_collecting` | 有档期，未给身高体重 |
| `size_confirming` | 三项齐，正在确认尺码 |
| `availability_checking` | 尺码确认，正在查档期/库存 |
| `review_confirming` | 已查可用，正在和客户复核 |
| `order_guiding` | 复核通过，引导下单 |
| `post_order_followup` | 已下单后跟进 |

### 4.2 nextAction 枚举

`ask_product` / `ask_rental_period` / `ask_body_measurements` / `confirm_size` / `check_availability` / `confirm_review` / `guide_order` / `answer_question` / `close_loop`

### 4.3 流程

```
decideStage(readiness, profile, productId) → stage
decideAction(stage) → { nextAction, currentGoal, replyTemplateKey, ... }
buildPendingSlots(readiness) / buildCompletedSlots(profile, productId)
buildBlockingIssues(profile, handoffStatus)
合并成 ConversationOrchestration 对象
```

### 4.4 主动追问限流

- `proactiveFollowUpCount` / `proactiveFollowUpLimit`（默认 2）
- 每次客服回复包含 `followUpQuestion` 时计数 +1
- stage 推进 / 用户提供新事实时清零
- 达到上限时 `paused = true`，不再主动追问

---

## 5. Memory Store（src/memory-store.ts）

### 5.1 数据结构

```
memoryMap: Record<customerId, CustomerMemory>
CustomerMemory:
  customerId
  globalSummary: string
  bodyProfiles: BodyProfile[]
  sessionContext: Record
  productMemories: Record<conversationKey, ProductMemory>
  overallRating?: number
  totalReviews: number

ProductMemory:
  productId
  conversationId
  summary: string
  recentMessages: MemoryMessage[]   ← 上限 6 条（MAX_RECENT_MESSAGES）
  conversationProfile: ConversationProfile
  reviews: Review[]                 ← 自动评分历史
```

`conversationKey = productId ? "${customerId}:${productId}" : "${customerId}:general"`

### 5.2 串行化锁

```ts
let memoryLock: Promise<unknown> = Promise.resolve();
function runWithMemoryLock<T>(fn): Promise<T>
```

所有写操作排队过锁：
- `appendConversationMemory`
- `markOrderPlaced`
- `addReview`
- `reEvaluateConversation`
- `scheduleReview` (异步评估)

测试用 `flushPendingReviews()` 等待锁清空。

### 5.3 异步评估

```ts
function scheduleReview(input) {
  void runWithMemoryLock(async () => {
    let review;
    try {
      const evaluation = await evaluateCustomerServiceReply(...);
      review = { score, ..., promptVersion, chatModel, evaluatorModel };
    } catch (e) {
      review = { score: 0, error: e.message, ... };
    }
    // 重新读 memoryMap → 追加 review → 写盘
  });
}
```

`appendConversationMemory` 写完消息立即返回，不等评估。

---

## 6. Prompt 加载（src/prompts-loader.ts）

```ts
config.promptVersionName = process.env.PROMPT_VERSION ?? 'v1'
   ↓
读 config/prompts/<version>.yaml + config/catalog.yaml
   ↓
sha1(combined yaml).slice(0, 6) → "v1-5a57d9"
   ↓
导出 loaded.prompts / loaded.catalog / loaded.promptVersion
```

启动时一次性加载，运行时不重读。改 YAML 后必须重启。

`loaded` 是模块级常量，全局唯一。`rag.ts` 和 `memory-store.ts` 都 import 它。

辅助函数：
- `findProduct(productId)` → catalog.products 查找
- `pickSizeByMeasurement(h, w)` → 按 sizeRules 命中（顺序匹配）
- `renderTemplate(tpl, vars)` → `{{key}}` 占位符替换

---

## 7. 评估器（src/rag.ts: evaluateCustomerServiceReply）

```
输入: conversationHistory[] + customerServiceReply
   ↓
模型: config.evaluatorModel
prompt: loaded.prompts.evaluatorSystemPrompt + renderTemplate(evaluatorUserTemplate, ...)
Responses text.format: json_schema { score, issues, suggestions, suggestedReply }
temperature 0.0
   ↓
首选: JSON.parse → 校验 score 范围 1-10
失败兜底: parseLooseEvaluation 用正则从自由文本里抠 score/issues/suggestions
两次都失败: throw → scheduleReview 落 error review
   ↓
return { score, issues, suggestions, suggestedReply, evaluatorModel, promptVersion }
```

### 7.1 防错正则兜底

`parseLooseEvaluation` / `parseJsonArrayValue` 应对模型不严格遵守 schema 的情况，能从 markdown / 自由文本里挖出关键字段。

---

## 8. Dashboard 数据流（dashboard/src/）

```
App.tsx 启动
   ↓ 三个并行 fetch
   ├── /config/info          → loaded prompt 版本 + 模型
   ├── /reviews/summary      → 聚合（promptVersions / topIssues / topSuggestions）
   └── /memories/all?limit=200 → 全部对话原始数据
   ↓
SummaryCards / VersionTable / ConversationList / FrequencyList
   ↓
点会话 → ConversationDetail 显示 profile + messages + reviews
   ↓
点"重新评估" → POST /reviews/evaluate → reload summary + customers
```

`/reviews/summary` 实现在 `memory-store.ts: getReviewSummary()`，全量遍历 memoryMap 聚合。数据量大时考虑分页或缓存。

---

## 9. 知识检索（src/rag.ts + src/chunking.ts）

```
ingest 阶段:
  walk(docs/) → 每个文件 chunkText() → embedText() → upsert to Qdrant
  特殊：CSV with headers 'question,answer' → chunkQaCsv() 每行一个 chunk
  其它文件：chunkText() 滑动窗口（CHUNK_SIZE=500, OVERLAP=80）

query 阶段:
  embedText(question)
  Qdrant 可用时：qdrant.search(collection, vector, limit=5)
  不可用时：readLocalVectors() + cosineSimilarity 全量排序
```

### 9.1 KnowledgeChunk 字段

```ts
{
  id, text, sourceType: 'rule'|'history'|'product', contentType: 'qa'|'text',
  filePath, title, chunkIndex
}
```

`sourceType` 由 `inferSourceType(filePath)` 根据目录推断：`/rules/` → rule, `/history/` → history, `/products/` → product。

### 9.2 与 Action 路由的关系

知识检索结果只在两种情况下真正"使用"：
1. **`answer_faq` action**：references 拼进 LLM 分类器的 user content，让 LLM 据此写 faqAnswer
2. **客户端调试展示**：作为 `references` 字段返回给前端，方便看命中了什么

其它 fast-path action 不消费 references（它们的话术全是模板）。

---

## 10. 扩展指南

### 10.1 加新业务规则（如新尺码段）

```yaml
# config/catalog.yaml
sizeRules:
  - { minHeight: 160, maxHeight: 167, minWeight: 45, maxWeight: 54, size: S, confidence: medium }
```

不需要改代码。

### 10.2 加新 SKU

```yaml
# config/catalog.yaml
products:
  - id: DRESS-001
    name: 红色长裙
    dailyPrice: 159
    renewalDailyPrice: 79.5
    ...
```

`server.ts: resolveProductIntentText` 里如果要加 SKU 默认意向词，也要补一行。

### 10.3 加新关键词意图

```ts
// src/rag/intents.ts
export function isReturnPolicyQuestion(q: string) {
  return /退货|退款|怎么退|不想要了/.test(q.replace(/\s+/g, ''));
}

// src/rag/actions.ts
| { kind: 'return_policy_info' }

// src/rag/templates.ts
case 'return_policy_info':
  return '退货规则是...';

// src/rag/action-picker.ts （在合适优先级位置）
if (isReturnPolicyQuestion(q)) return { kind: 'return_policy_info' };
```

### 10.4 接真实库存系统

修改 `src/availability-service.ts`：

```ts
export async function queryAvailability(input: AvailabilityQueryInput) {
  const resp = await fetch('https://your-inventory-api/check', { ... });
  return await resp.json() as AvailabilityQueryResult;
}
```

下游（`memory-store.ts: inferAvailabilityCheck`）会自动使用真实结果。

### 10.5 切换主回复模型

```env
MIMO_MODEL=mimo-2.5
MIMO_EVALUATOR_MODEL=mimo-2.5
```

注意：如果模型不支持 OpenAI tool-calling 协议，`callClassifier` 会失败 → 整个 step 13 兜底分类器失效 → 大部分 fast-path 还能用，但 follow_flow 兜底走 ask_product。

---

## 11. 调试技巧

| 想看什么 | 看哪 |
|---|---|
| 这一句被分到哪个 action | `/chat` 响应里的 `action` 字段 |
| LLM 分类器选了哪个 mode | 加 `console.log` 在 `action-picker.ts: callClassifier` 返回前 |
| 评估器输出原始文本 | `evaluateCustomerServiceReply` 已经 `console.error` 解析失败时的 rawText |
| memory 是否被更新 | `data/memory-store.json` 直接 cat |
| 检索命中了什么 | `/chat` 响应的 `references` 字段 |
| orchestrator 怎么走的 | `productMemory.conversationProfile.orchestration` 完整 dump |
| 当前 prompt 版本 | `/config/info` |

---

## 12. 性能 / 成本提示

每条 `/chat`：
- 1 次 embedding（搜索）
- 1 次 LLM（事实抽取，`extractStructuredConversationFacts`）
- 0 或 1 次 LLM（action 兜底分类器，仅当 fast-path 不命中）
- 异步：1 次 LLM（评估器，不影响响应延迟）

约 60-70% 的对话只需：1 embedding + 1 fact extract LLM 调用（约 1-2s 响应）。

如果想进一步降本：
- 把 `extractStructuredConversationFacts` 改成正则优先 + LLM 兜底（现在反过来）
- 把 fact extract 也异步化
- 用更小的模型（`mimo-2.5`）做分类器和事实抽取，主回复保留大模型（但当前架构主回复多数走模板，不需要大模型）
