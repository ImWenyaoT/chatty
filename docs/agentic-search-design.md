# Agentic Search 设计：SQLite FTS5 + search_knowledge 有界工具循环

> 状态：设计定稿（feat/agentic-search 分支）。
> 立场来源：docs/tech-stack-decisions.md §11（No RAG / No Vector DB / FTS-LIKE is enough）。
> 复杂度天花板：不超过任何一个参考仓的对应机制，且默认更简。判断标准唯一：
> 金标 11/11 平价做不到才允许加复杂度；"为未来扩展"不是理由。
> 参考权重：产品形态（知识如何参与回复、循环形状、对客约束）对齐 openclaw；
> 工具机制（schema、截断、描述文案、迭代教法）参考 claude_code / codex / opencode / pi。
> 两类冲突时形态听 openclaw、机制听 coding agents，冲突记录见 References。

---

## 0. 实施批次（B1–B5）

总代码预算：**净新增 ≤ 700 行（不含测试）**。任一组件实施时超出下表预算 ≥50%，
视为设计告警信号——先回到本文档修设计，再继续写码。

| 批次 | 内容 | 验收标准 |
|---|---|---|
| **B1 索引层** | 语料迁移（`rag-service/docs/` → `knowledge/`，`catalog.yaml` → `knowledge/catalog.yaml`）；FTS5 schema 追加进 `sqlite-schema.ts`；`packages/db` 新增 chunker + 幂等索引同步 + `createKnowledgeRepository(db).search()`（trigram MATCH + 短词 LIKE 回退） | `pnpm test` 绿；单测覆盖：2 字中文词（"西装""押金"）与 3+ 字词（"双排扣"）均命中、空结果返回空数组、bm25 同分按 rowid 稳定排序、索引重建幂等（同 hash 跳过）；迁移后跑一次 legacy 金标确认 11/11 不掉（金标不依赖检索，纯移动安全） |
| **B2 工具与 adapter** | `RuntimeTool` 加可选 `parameters`（JSON Schema）；`search_knowledge` 工具（risk low，注入 db 句柄，工厂 `createSearchKnowledgeTool(repo)`）注册进 registry；`packages/llm` 新增 `completeWithTools()`（消息类型扩展 `assistant.tool_calls` / `role:'tool'`） | 单测覆盖：policy 门对 low 放行、closed session 拒绝；mock client 下 `completeWithTools` 能解析 tool_calls 回复与纯文本回复两种形态；工具返回文本符合 §3 结果格式契约（含空结果、截断尾行） |
| **B3 有界循环** | compose 步扩展为有界工具循环（≤3 次搜索，harness 硬编码）；新 `kind:'knowledge'` fragment；`CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS` 增补；达上限注入"工具已禁用，直接输出 action JSON"收尾；任何模型失败回退确定性 composer | 无 key 时行为与现状逐字节一致（现有确定性测试全绿）；mock modelFn 循环测试覆盖：搜索→作答、达上限强制作答、坏 tool_calls 参数返回错误文案重试且计入轮数；搜索调用出现在 trace 的 toolCalls 与 references 中 |
| **B4 评测迁移** | eval runner 抽象被测面为 `--target legacy\|harness`（进程内直调，非 HTTP）；断言词汇映射（stage/action/profile → 行为断言或映射表）；新增 3 个检索必答场景（店铺电话 / 换码政策 / 押金清洗，改造自 qa-examples.csv） | `--target legacy` 复现 iter4 的 PASS 集（11/11）；`--target harness` 能跑通全部场景并出报告（此批允许不达标）；检索必答场景在 harness lane 因缺检索会 FAIL——证明闸门有效 |
| **B5 达标与退役第一步** | prompt/工具描述调优至 harness lane 金标 11/11（--repeat 3 全过）+ 检索场景 PASS，`--save` 存 harness 基线；删除 legacy 检索子系统（qdrant client、embedding 调用、ingest.ts、chunking.ts、local-vectors）；更新 §16 账本与 open-source-adoption.md | 11/11（--repeat 3，每场景 avgScore ≥ iter4 − 1.0）+ 3 个检索场景 PASS；`pnpm lint` `pnpm test` 绿；rag-service 的 package.json 无 qdrant/embedding 依赖；legacy 金标（走确定性模板路径）仍 11/11 |

各组件行数预算（超预算即告警）：

| 组件 | 位置 | 预算 |
|---|---|---|
| chunker + 索引同步 | packages/db | ≤150 行 |
| knowledge repository（search + 转义 + 回退） | packages/db | ≤100 行 |
| search_knowledge 工具 | packages/agent-core/src/tools | ≤80 行 |
| completeWithTools | packages/llm | ≤80 行 |
| compose 循环 + fragment + 指令增补 | packages/agent-core | ≤100 行 |
| eval runner 双目标改造 + 映射 | 评测脚本 | ≤200 行 + 3 个场景 YAML |

---

## 1. 背景与红线

要替换的东西：legacy `rag-service` 的 qdrant + embedding 检索链（每轮固定 top-5、
意图无关、DeepSeek 下 embeddings 404 恒空降级——见 §5 反模式实证）。

替换成什么：SQLite FTS5 索引（分块 + 摘要，索引期写入）+ 一个 `search_knowledge`
工具，LLM 在 harness 持有的有界循环里自己决定何时搜、搜什么、要不要换词再搜。

**红线（全部批次适用）：**

1. 不引入 embedding、向量库、分词库、新服务、新进程依赖——better-sqlite3 自带的
   FTS5 就是全部检索基建。
2. 检索实现保持 FTS5/LIKE 级别；不做缓存层、不做 I/O 微优化（§11：瓶颈在 inference）。
3. 工具必须走现有 `ToolRegistry` + policy 门（`invokeWithPolicy`），搜索调用必须
   出现在 trace 里；藏进 apps/web 闭包绕过这两个不变量是被否决的方案（见 §4）。
4. 金标 11/11 平价是删 legacy 的硬门槛；eval 质量是不变量，被换的只是检索实现。
5. 仓库风格：TypeScript strict、单引号无分号、函数级注释、biome。
6. 不 vendor 任何参考仓代码——只内化重写，出处落在 References。

---

## 2. 决策 a：索引形态

### 2.1 FTS5 表结构与 chunk 粒度

| 候选 | 来源 | 评价 |
|---|---|---|
| A1. 单个 FTS5 虚拟表，metadata 用 UNINDEXED 列 | openclaw builtin 后端（per-agent SQLite、FTS5 单表） | 一张表一个仓储函数，与仓库"幂等 schema 追加、无迁移框架"惯例吻合 |
| A2. 普通表存内容 + external-content FTS5 表 | SQLite 官方文档常见做法 | 省一份正文存储；但语料 <10KB，省的是零，多的是同步触发器 |
| A3. 不建索引，纯 LIKE 全表扫 | §11 "FTS/LIKE is enough" 的极端解读 | 最简，但丢 bm25 排序；多 chunk 命中时无相关度序，结果质量交给运气 |

**选择：A1。** 语料仅约 7.6KB / 约 30 个 chunk，任何存储优化都是零收益；
bm25 排序是唯一值得保留的"复杂度"，因为 top-3 截断需要一个相关度序。
A3 保留为短词回退路径（见 2.2），不是主路径。

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
  text,                -- chunk 正文（被索引）
  summary,             -- 规则生成的一行定位摘要（被索引）
  doc_id UNINDEXED,    -- 源文件相对路径，如 rules/rental-policy.md
  section UNINDEXED,   -- 标题链，如 租赁规则 › 租赁计费口径
  source_type UNINDEXED, -- rule | product | history
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS knowledge_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_hash TEXT NOT NULL,   -- 全部源文件内容的 sha1，幂等同步依据
  built_at TEXT NOT NULL
);
```

chunk_id 即 FTS5 rowid：重建时按 doc_id + section 顺序插入，天然确定性，
不需要独立 id 列。

**chunk 粒度**（对比 legacy 的 500 字符/80 重叠滑窗——那是给 embedding 凑窗口的
无语义切法）：

- Markdown：按 `##` 二级标题切 section，一个 section 一个 chunk；无二级标题的
  小文件（common-qa.md、suit-guide.md）整文件一个 chunk。单 chunk 超约 1200 字符
  再按段落切一刀。
- CSV QA（qa-examples.csv）：每行一个 chunk，`Q: …\nA: …` 成对——这是 legacy
  chunking.ts 里唯一语义正确的分块方式，原样内化。
- 图片语料（public/media/*.jpg 的 caption chunk）：**不迁移**。金标 11 场景零依赖
  图片检索，legacy 的图片三层过滤（商品 ID/类型/分数门控）随检索子系统一起退役。

openclaw builtin 的 400 token + 80 重叠默认值记录在案，但对本仓不适用：
重叠是滑窗切法的补丁，语义切分不需要重叠。

### 2.2 中文分词（本设计最大技术雷区，已实测）

better-sqlite3@12.11.1 / SQLite 3.53.2 实测结论：

- `unicode61` 不切连续中文——对"黑色双排扣西装…"查"西装" MATCH **0 命中**；
- `trigram` 对 3+ 字查询命中（"双排扣" ✓），但 2 字查询（"西装""押金"）MATCH
  失败；不过 trigram 表上 `LIKE '%西装%'` 可命中且被索引加速。

| 候选 | 来源 | 评价 |
|---|---|---|
| T1. trigram tokenizer + 短词（<3 字）或零命中时 LIKE 回退 | 本仓实测；openclaw 的"空结果自愈一次"思想 | 零新依赖、两条查询路径都被 SQLite 索引覆盖，回退逻辑约 10 行 |
| T2. 索引期与查询期自行按字/二元切分，配 unicode61 | 传统中文全文检索做法 | 要维护自制切分器（写入面+查询面双份），换来的排序质量在 30 个 chunk 上不可测得 |
| T3. jieba 类分词依赖 | — | 违反红线 1，直接排除 |

**选择：T1。** 查询词 ≥3 字走 `MATCH`（服务端转义后按短语双引号包裹）取 bm25 序；
查询词 <3 字或 MATCH 零命中时回退 `LIKE '%q%'`（text 与 summary 两列），按 rowid
稳定排序。客服高频词恰是 2 字词（"价格""尺码""退款""换码"），LIKE 回退不是边角料
而是主战场之一，必须有专门单测钉住。

排序确定性（服务测试与 prompt cache）：`ORDER BY bm25(knowledge_chunks) ASC,
rowid ASC`——bm25 同分用 rowid 打平局，内化自 claude_code 测试环境强制文件名排序
与 openclaw 的 score+path 双键排序。

### 2.3 摘要生成方式

| 候选 | 来源 | 评价 |
|---|---|---|
| S1. 索引时规则生成：`文档标题 › 标题链 › 首行截断` | pi 的"description 引用实现常量"零漂移哲学同源：确定性、免费、可测 | chunk 本身只有几百字，摘要的职责只是结果列表里的一行定位文本 |
| S2. 索引时一次性 LLM 生成摘要 | 任务书"分块+摘要"的重解读；OpenAI cookbook 常见做法 | 引入 build 期 API 依赖与不确定性（同语料两次构建产出不同索引），破坏幂等同步；金标不需要它 |
| S3. 无摘要列 | 极简派 | 省一列，但 QA 行 chunk 的 Q 部分与 markdown 的标题链是高价值检索面，放进独立列可被索引命中 |

**选择：S1。** 摘要 = `doc 一级标题 › section 标题 › 正文首行（截 60 字）`；
QA chunk 的摘要就是 Q 行。确定性、可单测、构建零成本。S2 记为"金标平价失败
且归因于召回质量时"的唯一升级路径——目前没有任何证据需要它。

### 2.4 索引构建时机

| 候选 | 来源 | 评价 |
|---|---|---|
| I1. 启动时幂等同步：openDatabase 后对比 source_hash，不一致则整体重建 | 仓库现有"schema 幂等追加"惯例的自然延伸；openclaw 1.5s 防抖重建的极简化 | 7.6KB 语料全量重建 <50ms；永远不会忘跑 ingest |
| I2. 独立 build 脚本（pnpm ingest） | legacy scripts/ingest.ts | 显式但会陈旧——legacy 正是这个模式，忘跑 ingest 时索引静默过期 |
| I3. 文件 watcher 增量更新 | openclaw 防抖 watcher | 对本仓语料规模是纯开销，排除 |

**选择：I1。** `syncKnowledgeIndex(db, knowledgeDir)` 在 `getRepos()` 初始化时
调用：读全部源文件 → sha1 → 与 meta 表比对 → 不一致则 `DELETE` 全表 + 重新分块
插入。整体重建而非增量：30 个 chunk 的增量逻辑比全量重建代码更多。

---

## 3. 决策 b：search_knowledge 工具 schema

### 3.1 参数面

| 候选 | 来源 | 评价 |
|---|---|---|
| P1. 仅 `query` 必选，top_k 服务端固定 | codex tool_search（query+limit 两参）再砍一参；opencode takeaway "服务端固定 top-k，少一个模型能填错的参数" | DeepSeek 少一个可填错的旋钮；语料 30 chunk，可调 limit 没有使用场景 |
| P2. `query` + 可选 `limit`（默认写进描述） | codex tool_search、pi grep 的 limit 模式 | 参考仓主流做法，但"模型自调预算"服务的是任意规模语料 |
| P3. `query` + `category`（rule/product/history）+ `top_k` | claude_code Grep 的 type/glob 过滤思路 | 三类语料合计 5 个文件，分面过滤是给大语料准备的；砍掉它金标不会掉 |

**选择：P1。** 单参数 `query: string`，服务端 `TOP_K = 3` 常量。
这比所有参考仓都简——理应如此（复杂度天花板条款）。命中 >3 时靠结果尾行
提示模型收窄关键词（见 3.2），而不是给模型加大预算的旋钮。

参数描述终稿（写默认值、写反幻觉、写示例——内化 claude_code/opencode 的
参数级 prompt 工程）：

```
query: 中文关键词或短语，2 到 8 个字为宜，例如"换码"、"押金"、"店铺电话"、
"租期计算"。不要输入完整句子，不要带标点。
```

FTS5 MATCH 语法**不暴露**给模型：服务端把 query 按空白切词、每个词双引号
包裹成短语再拼 MATCH 表达式（转义内化 claude_code 对 rg flag 注入的防御思路）。
模型永远写不出语法错误——语法错误面在服务端归零，比 codex "校验错误回给模型重试"
更进一步：连重试都不需要。留下的唯一模型可见错误是超时/DB 异常（见 3.3）。

### 3.2 结果格式与截断策略

纯文本，不给模型 JSON（opencode grep 三段式内化）：

```
找到 5 条相关内容，显示最相关的前 3 条：

[1] 来源：租赁规则 › 租赁计费口径
第一天按全价计算。续租按半价计算。在途时间不计入租期。寄出一般包邮，
新疆、西藏等偏远地区除外。…

[2] 来源：常见客服问答
Q: 租衣服需要押金吗？
A: 是否需要押金以及押金金额，需要根据具体商品和订单规则确认。

[3] …

（还有 2 条未显示。如需更精确的结果，换更具体的关键词再搜一次。）
```

截断两层设防（claude_code 三层砍掉"落盘持久化"层——对 30 chunk 语料是过度设计）：

1. 单条 chunk 正文上限 800 字符，超长截断加 `……[已截断]` 后缀（内化 pi 的
   500 字符/行 + 后缀模式）；
2. 单次工具结果总上限 4000 字符，到顶停止追加条目并在尾行说明。

空结果 ≠ 失败，两者必须可区分（claude_code ripgrep 超时传播原则）：

- 空结果：`未找到与"押金 多少"相关的内容。换更短或不同的关键词再试一次，
  例如把长短语拆成单个词。`（显式文案 + 可执行建议，绝不回空串）
- 失败（超时 2s / DB 异常）：`知识库搜索暂时不可用。请基于已知信息谨慎回答，
  不确定的内容如实告知用户无法确认。`（内化 openclaw 的失败契约面向模型设计；
  cooldown 机制砍掉——有界循环最多 3 次调用，没有"连续打挂"可防）

内容卫生：chunk 正文入索引前剥离 markdown 图片行与内部路径（legacy
action-picker `stripMarkdownImageLine` 有真实事故注释：/media/ 路径被 LLM
原样复制给客户）。索引期做一次，比返回期每次过滤更省。

返回值结构（模型文本与元数据分离，内化 opencode 三元组）：工具 `execute` 返回
`{ output: string, matches: number, truncated: boolean }`——`output` 进消息流，
`matches/truncated` 落 trace 供评测统计检索命中率。

### 3.3 工具描述文案（终稿——prompt 工程核心交付）

形态与机制的一次显式冲突及取舍：coding agents 的搜索工具描述是"能力+语法+
何时不用"的中性工具书（grep.txt），openclaw 的 memory_search 描述以
**Mandatory recall step** 开头强制触发。客服助手若不被推着搜就会凭参数记忆
编造政策——这是形态问题，**听 openclaw**；截断契约、示例、反重复条款是机制
问题，**听 coding agents**。终稿：

```
搜索店铺知识库。在回答租赁政策、计费与包邮口径、换码/退换、押金、清洗、
店铺信息（名称/电话）等事实性问题之前，必须先用本工具搜索，不要凭记忆回答。
知识库覆盖：租赁规则与计费口径、下单引导与客服话术（rules）；
黑色双排扣西装商品说明（products）；历史客服问答（history）。
返回最相关的前 3 条，每条含出处和正文，结果超过 3 条时会提示剩余数量。
没有命中时，换更短或同义的关键词再搜一次；已经拿到答案后，不要用相同的
关键词重复搜索。商品价格、尺码推荐、库存这类结构化事实优先用
get_product / check_availability，不要靠本工具。
```

要点逐条溯源：
- "必须先搜…不要凭记忆回答" ← openclaw memory_search "Mandatory recall step"；
- 知识库覆盖清单 ← codex tool_search 在描述里动态渲染可搜来源目录（本仓语料
  静态，写死即可，语料结构变更时随 B1 的 chunker 一起改）；
- "换更短或同义的关键词再搜一次" ← claude_code general-purpose agent
  "Start broad and narrow down / 换搜索策略"，压缩为一句；
- "不要用相同的关键词重复搜索" ← opencode trinity.txt 弱模型反死循环条款
  （DeepSeek 属于该教学风格的目标模型）；
- "结构化事实优先用 get_product" ← 工具间互相指路（opencode grep.txt/task.txt
  模式）+ legacy 教训：精确数值（199 元/尺码表）永远走 catalog 结构化通道，
  不进 FTS5 靠召回（§5）。

系统级增补（进 `CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS`，对应 openclaw 的
"## Memory Recall" prompt 小节，含诚实条款）见 §4.3。

---

## 4. 决策 c：循环控制

### 4.1 循环放在哪层

| 候选 | 来源 | 评价 |
|---|---|---|
| C1. apps/web 的 modelFn 闭包内做 chat.completions tools 多轮 | 最小改动直觉 | **否决**：搜索调用绕过 policy 门与 trace 两个既有不变量；harness 注释明言 "harness owns workflow shape and safety posture" |
| C2. harness compose 步内有界循环（工具调用走 registry.invokeWithPolicy，结果进 fragment + trace） | openclaw "检索触发=模型主动，harness 不编排"；本仓 harness 边界注释 | 改动面集中在 customer-harness.ts + llm adapter，playground route 几乎不动 |
| C3. compose 前独立 gather 步：先检索再单发 compose | legacy pipeline-fixed 检索的温和版 | 模型失去"带着第一次结果改写 query 再搜"的能力——这正是 agentic search 相对 legacy 的全部增量（§5 反模式实证），选它等于白做 |

**选择：C2。** 接口变更：

- `CustomerServiceModelFn` 保留（确定性回退与旧调用方不动），新增
  `CustomerServiceToolLoopFn`：`(messages, tools) => Promise<{ toolCalls?: … } | { text: string }>`，
  由 apps/web 用 `completeWithTools` 实现注入；
- `composeCustomerServiceModelOutput` 收到 toolLoopFn + registry 时进入循环：
  模型发 `search_knowledge` tool_call → `registry.invokeWithPolicy`（risk low
  自动放行，closed session 被 policy 拒绝）→ 结果以 `role:'tool'` 消息回填 →
  下一轮；模型输出纯文本时按现有 `parseCustomerServiceOutput` 收口；
- 每次搜索结果同时追加为 `kind:'knowledge'` 的 ContextFragment——沿
  route.ts 现有管道自动落进 trace 的 `input_json` 与 `references_json`，
  对齐 legacy references 语义，GUI 可见"哪条知识塑造了这条回复"。

### 4.2 最大轮数与收尾

| 候选 | 来源 | 评价 |
|---|---|---|
| M1. 无硬上限，靠 token 记账 + 超时体系 | codex（compaction）、openclaw（watchdog 三件套）、pi（交互式有人打断） | 三仓都为此付出整套配套件；自动化客服没有"有人随时打断"的前提 |
| M2. 硬上限 3 次搜索 + 到顶优雅收尾 | opencode max-steps（到顶注入"工具已禁用，只能文本作答"而非报错）；claude_code maxTurns 显式信号 | 上限拍在"搜一次→换词再搜→再收窄一次"的自然长度上；配套件为零 |

**选择：M2，`MAX_SEARCH_CALLS = 3`，harness 硬编码常量**（不是配置项——可配置
就是待解释的复杂度）。到顶时最后一次模型调用不带 tools 参数，并追加一条
用户消息：`知识库搜索次数已用完。基于以上搜索结果，直接输出 action JSON。`
保证客服场景永远有回复（opencode max-steps 优雅收尾内化）。金标 harness 可
断言"达上限仍产出合法 action"。codex 的启示记录在案：上限本质锚定 token 预算，
金标实测后若 3 次不够可调——但调整需要金标证据，不预留旋钮。

### 4.3 DeepSeek function calling 不稳时的回退

分层防御（每层独立，内化 legacy 三层防线思想）：

1. **中间轮次与末轮分离**：循环轮次用 `tools`（不带 response_format——不假设
   provider 同时严格支持两者）；末轮/无 tool_calls 时沿用现有
   `parseJsonObject` 宽容解析（fenced JSON 兜底，f941c0f 修过的坑不再踩）。
2. **坏 tool_call 参数容错**：模型给出不可解析的 arguments 时，以 `role:'tool'`
   回 `query 参数缺失或不是字符串，请重试，只需提供 query 一个参数`（codex
   RespondToModel 模式），计入轮数防刷。数字/布尔容错（claude_code
   semanticNumber）不需要——单 string 参数没有 coercion 面。
3. **整体失败兜底**：循环任何一步抛错（网络/超时/解析全失败）→ 落回确定性
   composer（`createCustomerServiceModelOutput`），"无 key 可跑 / 模型失败
   必有回复"不变量原样保持。回退发生时 trace 里可见（现有 answerSource 思想），
   评测可统计回退率。

系统指令增补（`CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS` 末尾追加两行，
对应 openclaw prompt-section 的 Memory Recall 小节 + 诚实条款 + 对客卫生）：

```
回答政策、费用、售后类事实问题前，先调用 search_knowledge 搜索知识库；
搜索后仍不确定的内容，如实告诉用户需要进一步确认，不要编造。
回复中不要向用户提及知识库、搜索过程或文档出处，用自己的话自然表述。
```

第三行是 openclaw citations off 模式的固化：对客回复不暴露内部出处，
出处只留在 trace/fragment 供审计。citations on/off 配置开关砍掉——
本产品没有"需要给用户看出处"的场景。

---

## 5. 决策 d：评测迁移

先钉住两个事实（迁移方案的地基）：

- **金标现状不测检索**：DeepSeek 下 embeddings 404 → references 恒空，
  11/11 仍全过——断言的知识事实全部来自 catalog.yaml→Action 模板硬编码。
  所以 11/11 平价证明的是**编排与回复质量平价**，不是检索质量；检索质量
  需要新增场景做闸门。
- **legacy 每轮固定检索是反模式实证**："在吗/你好"也触发 top-5 检索，而结果
  只被 answer_faq 单通道消费——这是 §11 "让模型决定何时搜"的直接论据，
  也是 C3（gather 步）被否决的理由。

### 5.1 eval runner 入口

| 候选 | 来源 | 评价 |
|---|---|---|
| E1. 进程内直调 `runCustomerServiceHarnessStep` + memory repos（复刻 route.ts 步骤 1–5b，去 HTTP/auth） | legacy eval.ts 本就是进程内直调 answerQuestion 的同构做法 | agent-core/db/llm 全部 Next-free；judge 可同步 await，分数直接回填 step |
| E2. HTTP 打 /api/playground | "测生产路径"直觉 | 要起 Next server；eval-chain 评分是 fire-and-forget，响应里拿不到分数，还得回读 trace_reviews 表——为了薄收益引入厚基建 |

**选择：E1。** runner 抽象为 `sendTurn(target, scenario, question) →
{ answer, action?, taskKind?, memorySnapshot?, score? }`，`--target legacy`
走现有 answerQuestion 直调（原路径不动），`--target harness` 走新入口。
judge 保持 legacy `evaluateCustomerServiceReply` 本体不动（对比公平的前提），
harness 侧由 runner 同步调用 judge 回填分数——比 legacy 的
flushPendingReviews + evaluatedReply 字符串精确匹配**更简**，删掉一个脆弱环节。

**「本体不动」的边界（两处测量保真参数，非评分行为）**：被冻结的对比不变量是
judge 的**评分口径**——system/user 模板、rubric、`temperature=0.0`、`top_p=1`
逐字不动。下列两项是测量保真参数，允许调整且对两条 lane 对称施加，不改变任何
一次能完整落盘的判分：

1. **judge `max_tokens`：800 → 2000**。v4-pro judge 的中文
   issues+suggestions+suggestedReply 常超 800，被截断的 JSON 无法严格 parse，
   宽松兜底抠不回真实分而钉在下限 1（在完美回复上打 1 分，污染测量）。提到 2000
   只是让判分 JSON 完整，方向单调——它只会把**被截断误钉到 1** 的分数还原成真实
   较高分，不会改变一次已放得下的判分。见 §5.5 的基线可比性说明。
2. **被测系统的 chat 模型可按 lane 分离**（`LEGACY_CHAT_MODEL` /
   `HARNESS_CHAT_MODEL`，见 eval-env.ts）。legacy 的 answerQuestion 走强制
   `tool_choice`（intent-classifier / action-picker），thinking 档模型
   （deepseek-v4-pro）以 HTTP 400 拒绝，legacy 对照 lane 会整体崩掉，红线 4
   平价无从复现。judge **对两条 lane 完全同一**，被分离的只是「被测系统」自身的
   推理模型——这恰是对比要测的对象（各自跑在能工作的模型上），不是 judge。

零成本移植的 legacy 评测基建（不重写）：promptVersion 哈希追溯、`--repeat N`
全过才 PASS + 均值抵 judge 噪声（实测 ±2）、`--baseline` Δ 对比 + PASS
lost/regained、eval-env preload 隔离（ESM import 提升坑已踩过，preload 必须
第一条 import）。

### 5.2 场景 context/memory 准备

每场景独立 SQLite（`CHATTY_DB_PATH` 指向 `tests/.tmp/`，每 run 前删除重建，
复用 eval-env preload 模式）；多 step 场景逐 step 走 harness 入口累积记忆，
与 playground 行为一致。知识索引在 runner 启动时同步一次（I1 机制自动覆盖）。

### 5.3 断言词汇映射

11 个场景的 `contains/containsAny/notContains/notSameAsPrev/minScore` 是
行为断言，直接复用。`action/stage/profile` 是 legacy 实现词汇（22 种 Action、
orchestrator stage），harness lane 没有也**不应该有**——为凑断言把 legacy
状态机搬进新 lane 是本设计明令禁止的方向。处理原则：

- **质量不变量 → 改写为行为断言**：如 `action: quote_price` 的意图其实是
  "回复必须含 199"（已有 contains 断言兜着）；`stage: review_confirming` 的
  意图是"回复在向用户复核三要素"——补 containsAny 断言表达；
- **可映射的保留映射**：`action → harness action kind` 初表：
  ask_product/ask_schedule/ask_body → `ask_missing_info`；answer_faq/
  rental_howto/quote_price/current_link_confirm → `answer_question`；
  size_recommend → `recommend_size`；handoff → `handoff`；其余逐场景在 B4 定夺；
- harness 版金标场景文件独立存放（legacy 版原文件不动，直到 B5 删除），
  两份场景的语义等价性在 B4 的 PR 里逐场景说明。

`profile` 断言依赖 §16 账本的"profile 写路径迁 SQLite"（🟡 项）——该项不在
本设计范围内；B4 中 profile 断言暂以 memorySnapshot 现有字段（recentMessages）
可表达的部分改写，其余标注 blocked-on-§16 并在平价判定中豁免（见 5.5）。

### 5.4 新增检索必答场景（search_knowledge 的质量闸门）

从只存在于 docs/ 文本、catalog/模板均不含的事实里取材，qa-examples.csv 现成：

1. **store-contact**：问店铺名称/电话 → 回复必须含"示例租衣店"与"18800000000"
   （contains），且这两个事实只在 rental-policy.md/qa-examples.csv 里存在；
2. **size-exchange-policy**：问"不合身能换吗" → 必含"免费补发"或"更换一次"
   （containsAny）；
3. **deposit-cleaning**：问押金与清洗 → 必含"根据具体商品和订单规则确认"类
   口径且 notContains 编造的具体金额。

这 3 个场景在检索缺失时必然 FAIL（B4 验收即验证此性质），是 FTS5 索引/工具/
循环全链路的端到端闸门。它们**不计入** 11/11 退役门槛（门槛口径保持与任务
定义一致），但 B5 达标验收要求其 PASS。

### 5.5 平价判定口径

- **PASS 口径**：11 场景 × `--repeat 3` 全过（沿用 aggregateRuns：全 3 轮
  pass 才算 PASS）；
- **分数口径**：逐场景 `avgScore ≥ iter4 基线同场景 avgScore − 1.0`。
  基线 = `tests/reports/iter4.json`（promptVersion v1-285010，11/11，
  avgScore 7.67–9.0）。容差 1.0 的依据：judge 单次噪声实测 ±2，3 次均值后
  取 1.0；**不用总均分做验收**（judge 锚定 8 分、天花板 ~8.4，均分不敏感）；
- **基线可比性（judge 配置一致性）**：`iter4.json`（2026-06-28）是在
  judge `max_tokens=800` 且 pre-v4-pro judge 下测得的；§5.1 已把 max_tokens
  记为测量保真参数。截断偏差单调向下（只把放不下的判分钉到下限 1），故 800-cap
  基线相对 2000-cap 是一个**保守（≤）参照**——门槛若因此偏移只会更严不会更松；
  且 legacy 的模板回复短、判分在 800 内本就放得下（iter4.json 无一处 1 分即证）。
  **硬约束**：在 §6 的 R4 删检索子系统真正以此门为闸之前，基线与 harness lane
  必须在**同一 judge 配置**（`max_tokens=2000` + 同一 judge 模型）下测得——
  即用 `LEGACY_CHAT_MODEL` 让 legacy lane 可跑后，在 2000-cap 下重测一次基线
  落 `tests/reports/`，把这次重测记进 R3 报告；重测前只把 iter4 当保守参照用；
- **豁免项显式化**：blocked-on-§16 的 profile 断言豁免清单随 B4 报告落档，
  豁免不是删除——§16 闭环后回补。

---

## 6. 决策 e：退役顺序

> **状态更新（2026-07）：R4 已执行。** 检索子系统（qdrant client、embedding 调用、
> `ingest.ts`、`chunking.ts`、local-vectors、`rag.ts` 内 `searchKnowledge`/`embedText`、
> `@qdrant/js-client-rest` 依赖）已在单独 commit 中删除，agentic search 上线为当前检索路径。
> 同批把评测飞轮拆回朴素金标回归（`pnpm eval --target harness`，见 §16 R4 记录）。
> **平价门被用户决策覆盖**：本节 R3/R4 写的"11/11 平价才准删"是设计期的硬门槛；实际
> harness lane 最好一轮 13/14，用户明确决策 RAG 直接退役、不因平价未达标而阻塞
> （求职作品集项目，dont overdo）。R5（answerQuestion/orchestrator/memory-store 整体删）
> 仍未做，范围外。

范围澄清（诚实边界）：`rag-service` 的**整体**删除还依赖 §16 账本的
"事实抽取 + 阶段状态机"（🔴）与 "profile 写路径"（🟡）两项，不属于本设计。
本设计负责的退役对象是**检索子系统**（qdrant + embedding + ingest 链）与
**评测资产的迁出**；answerQuestion 整体删除的门槛（金标 11/11 平价）由本设计
的 eval 迁移铺好轨道。

| 步 | 动作 | 安全网 |
|---|---|---|
| R1（=B1） | 语料迁出：`rag-service/docs/` → `knowledge/`，`config/catalog.yaml` → `knowledge/catalog.yaml`；legacy 侧改读新路径（一行常量） | 迁移后跑 legacy 金标 11/11——金标不依赖检索与 ingest，纯路径移动零行为风险；catalog 由 prompts-loader 直读，路径改动有单测钉住 |
| R2（=B4） | 评测资产迁出：golden YAML、reports 基线、eval.ts/eval-env.ts 内化为双目标 runner；judge（evaluator.ts）迁到共享包（它是留下来的部分，先迁走再删宿主） | `--target legacy` 复现 iter4 PASS 集后才算迁移完成；原 eval.ts 保留到 R4 作对照 |
| R3（=B5 前半） | harness lane 达标：11/11（--repeat 3）+ 检索场景 PASS，`--save` 存 harness 基线报告 | 达标报告 + promptVersion 落 tests/reports/，作为 R4 的回归基线 |
| R4（=B5 后半） | 删检索子系统：rag.ts 内 searchKnowledge 调用点、ingest.ts、chunking.ts、embedding client、qdrant 依赖、local-vectors.json 路径 | 单独一个 commit（好 revert）；删后 legacy 金标仍 11/11（检索恒空早已是事实行为，删除只是把 404 降级变成不存在）——该 11/11 平价须在 legacy 经 `LEGACY_CHAT_MODEL` 跑通、且与 harness 同一 judge 配置（`max_tokens=2000`）下重测基线后取得（§5.5 基线可比性）；`pnpm lint && pnpm test` 绿 |
| R5（本设计范围外，前置=§16 闭环） | 删 rag-service 运行时整体（answerQuestion/orchestrator/memory-store），playground 与生产默认走 harness lane | 门槛：harness lane 金标 11/11 平价（R3 已备）+ §16 红黄项闭环；届时 legacy 版 golden YAML 一并删除，双目标 runner 退化为单目标 |

顺序设计原则：每一步删除前，被删物的**消费方先清零**（openclaw
"Existing-solutions preflight" 的镜像：删除前先查还有谁在用）；每一步都有
可独立回滚的 commit 边界与一条金标复跑作安全网。

---

## References

内化不 vendor：以下全部为设计参考，无任何代码复制。格式仿 pi README
Philosophy 节的"借了什么 / 改了什么 / 弃了什么及原因"三段式。

### openclaw（产品形态最高权重）

- **借**：memory_search 的 "Mandatory recall step" 工具描述开头 + system prompt
  的 Recall 小节双重强化（tools.ts:397、prompt-section.ts）→ §3.3/§4.3 终稿；
  "If low confidence after search, say you checked" 诚实条款；失败契约面向模型
  设计（结构化 warning/action 而非抛异常）；两层知识注入（小摘要常驻、大语料
  只走工具）；score+path 双键确定性排序；FTS5 单表 per-agent SQLite 索引形态；
  provider:'none' 纯 BM25 为一等公民——本设计 No-Vector-DB 立场的同类产品背书
  （其根 AGENTS.md "Storage default: SQLite only" 同）。
- **改**：citations on/off 配置固化为"永不对客暴露出处"（本产品无展示出处场景）；
  空结果自愈（重建索引再搜一次）简化为结果内换词提示——启动时幂等同步已消除
  索引陈旧的主要来源；15s 超时 + 60s cooldown 简化为 2s 超时、无 cooldown
  （有界 3 次循环没有连续打挂面）。
- **弃**：4 后端 × 10 embedding provider 插件矩阵、memory-wiki、dreaming 晋升
  管线、compaction 前记忆冲刷、无上限 loop + watchdog 三件套——平台型产品的
  包袱，单库 30 chunk 语料全部用不上。无上限 loop 与本仓有界循环的冲突属
  形态 vs 工程冲突，取有界：自动化客服无"有人随时打断"前提（记录在 §4.2）。

### claude_code

- **借**：参数描述即 prompt 工程的写法（默认值/成本警告/反幻觉指令，
  GrepTool.ts:33-90）→ §3.1 参数文案；"截断只在真发生时告知 + 附下一步动作"；
  空结果与失败的显式区分（ripgrep 超时传播注释）→ §3.2；迭代搜索教学放
  系统提示词而非 schema（"Start broad and narrow down"）→ §3.3；测试环境
  确定性排序（GrepTool.ts:542）→ §2.2 rowid 打平局；对 flag 注入的服务端
  防御思路 → §3.1 MATCH 转义。
- **改**：三层 token 设防砍为两层（单条上限 + 总量上限），落盘持久化层弃。
- **弃**：output_mode 多态、-A/-B/-C 上下文行、multiline、type/glob 过滤、
  mtime 排序、Explore/子 agent 分层、权限系统——任意代码库正则搜索的领域
  复杂度，FTS5 + 语义分块（chunk 即上下文单元）不需要；正则接口本身也弃
  （其 prompt 花两条讲转义坑，正说明正则对 LLM 是错误面）。

### codex

- **借**：tool_search 的极简 schema（query 必选 + limit 可选）再砍一参 → §3.1；
  工具描述内动态渲染可搜内容目录 → §3.3 知识库覆盖清单（静态化）；校验错误
  作为模型可读重试提示（RespondToModel）→ §4.3 坏参数容错；BM25 作为唯一
  词法排序器（bm25 crate）——与 FTS5 bm25 立场互证。
- **改**："上限锚定 token 预算而非拍脑袋轮数"的启示保留为调参原则，但实现
  取硬编码 3 次（金标实测驱动调整，不预留旋钮）。
- **弃**：裸 shell + rg 路线（预设受过 rg/正则 RL 训练的模型与可信沙箱，
  DeepSeek + 客服 KB 两者皆无）、PTY 会话三态轮询、自动 compaction、
  max_output_tokens 模型自调预算、审批机器。

### opencode

- **借**：grep 结果纯文本三段式（Found N → 分组条目 → 截断行动建议）→ §3.2
  结果格式；可选参数反幻觉文案（'DO NOT enter "undefined" or "null"'）；
  max-steps 优雅收尾（到顶注入"工具已禁用，只能文本作答"）→ §4.2；
  弱模型 trinity 式教学（一次一工具、同参数不重复）→ §3.3 反重复条款，
  DeepSeek 正是该教学风格的目标画像；{output, metadata} 模型文本与元数据
  分离 → §3.2 返回值结构。
- **改**：条数上限 100 → 3（语料规模差四个数量级）；v2 暴露 limit 给模型 →
  服务端固定（其自身 takeaway 亦如此建议）。
- **弃**：截断落盘 + 7 天保留、Task/explore 子代理与 thoroughness 分级、
  per-call 权限询问、Effect-TS 注册架构、ripgrep 二进制管理。

### pi

- **借**：截断契约写进工具描述且引用实现常量防漂移 → §3.3 "返回最相关的前
  3 条"与 TOP_K 常量同源维护；"结果内可执行提示是驱动迭代的主机制，比
  system prompt 教学便宜"→ §3.2 尾行设计；双限截断不截半条记录；
  "No X. 为什么。替代方案。"的文档三段式 → 本 References 格式。
- **改**：pi 系统提示词零搜索教学（15 行哲学）本仓不完全采用——客服形态
  需要 Mandatory recall 推动（形态听 openclaw 的冲突记录：coding agent 的
  模型会自发搜代码，客服模型不会自发搜政策）。
- **弃**：无界循环（交互式 CLI 有人打断的前提不成立）、ripgrep/fd 子进程
  生命周期管理、可插拔远程后端、TUI 双渲染通道——约 60% 工具代码属于
  本仓不需要的领域复杂度。

### legacy rag-service（本仓内部迁移源）

- **借**：QA-CSV 行级分块（唯一语义正确的分块，原样内化）；stripMarkdownImageLine
  内容卫生（真实事故驱动）；GLOBAL_FORBIDDEN_PATTERNS 输出侧校验 + 确定性
  回退 + answerSource 回退率观测的三层防线思想；eval 基建四件套（promptVersion
  哈希、--repeat 聚合、--baseline Δ、eval-env preload 隔离）零成本移植；
  "结构化事实走 catalog 直读、LLM 只管措辞"的知识分层。
- **弃**：500 字符/80 重叠无语义滑窗（embedding 凑窗口的产物）；每轮固定
  top-5 检索（反模式实证：结果仅 answer_faq 单通道消费，"在吗"也触发检索）；
  qdrant + embedding 全链路（DeepSeek 下 404 恒空、金标证明其零贡献）；
  flushPendingReviews + 字符串精确匹配回填分数（换同步 await judge）。

### 附带记录

- luup 的产品形态对标 opencode（coding agent），与本仓无关；本文所有
  coding agent 参考仅限 search 工具机制层面，不构成对 chatty 产品形态的
  参考立场。
- 本文档新增于 feat/agentic-search 分支；采纳/放弃的依赖变更（qdrant 移除等）
  在 B5 落地时同步更新 docs/open-source-adoption.md 与
  docs/loop-engineering-plan.md §16 账本。
