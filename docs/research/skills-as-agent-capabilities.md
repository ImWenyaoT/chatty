# Skills as Agent capabilities

> 状态：设计研究已经由 ADR 0013 落地。本文保留研究过程，不描述当前运行时。

研究日期：2026-07-21
范围：`dontbesilent2025/dbskill`、`JimLiu/baoyu-skills`、`alchaincyf` 的代表性 Skill 仓库，以及本地 `learn-claude-code`、Luup、Chatty 与简历定位。

## 结论

Chatty 不应转成 Multi-Agent、通用工作流平台或真实媒体集成。Luup 已经证明 Long-Horizon Multi-Agent、动态任务依赖、证据边界和恢复；Chatty 更适合补足另一条简历证据：

> 基于一个约 2,000 行教学 Harness 演化出的、能完成研究、分析、内容生产和可验证交付的单 Agent MVP。

本研究中的 Skill 仓库是设计输入，不是 Chatty 的运行时依赖。Chatty 不实现 Skill catalog、`load_skill`、插件安装或 Skill 编排；它只选择性吸收其中成熟的领域方法、渐进上下文、确定性脚本、产物约束、失败路径、检查点与评价方法，再把它们固化进 Agent instructions、Tools、Artifact schemas、Harness 和 eval。

## 与现有简历的互补关系

当前简历对两个项目的区分已经很清楚：

- Luup：Long-Horizon Multi-Agent、动态 DAG、跨角色协作、研究证据和发布门禁。
- Chatty：单 Agent Tool Use、可信身份、Session、业务副作用、Memory、Handoff 和确定性 eval。

因此 Chatty 的升级重点应是：

1. 单 Agent 在一个 Loop 中完成研究、分析、内容生成和交付；
2. 将外部 Skill 中有价值的方法内化为固定能力，而不是建设 Skill runtime；
3. 中间 Artifact、人工检查点与可恢复状态；
4. 对 Agent 行为和最终 Artifact 做 eval；
5. 用一个端到端案例证明综合能力，而不是增加更多 Agent。

## `learn-claude-code` 提供的最小机制

本地 [`s07_skill_loading/code.py`](/Users/edward/Documents/learn-claude-code/s07_skill_loading/code.py) 展示了两层上下文控制：

1. Harness 启动时扫描 `skills/*/SKILL.md`，只把 `name + description` 目录放进 system prompt；
2. Model 需要时才加载完整内容。

Chatty 只内化“按需提供相关方法和资料”的原则：通过现有 Knowledge/RAG 给 Agent 提供任务相关方法，不暴露 Skill 概念或加载工具。[`s20_comprehensive/code.py`](/Users/edward/Documents/learn-claude-code/s20_comprehensive/code.py) 约 2,100 行，说明 permission、hooks、memory、context compact、task、background、MCP 等机制可以挂在同一个 Agent Loop 周围。但 Chatty 不复制 S20 的 Multi-Agent、cron、worktree、Skill runtime 和通用 coding tools；它只抽取 Artifact、checkpoint、recovery 和 eval。

## 仓库研究

### `dontbesilent2025/dbskill`

[`dbskill`](https://github.com/dontbesilent2025/dbskill) 是商业诊断方法、知识包、模板和确定性工具的 Skill 集合，不是 Agent runtime。仓库没有自己的模型调用或 Agent Loop；它依赖 Claude Code、Codex 等宿主完成选择和执行。

值得借鉴：

- Skill 有清晰的适用问题和非适用问题，而不是万能 Prompt；
- 多个 Skill 之间存在推荐的前后衔接，但宿主 Model 仍负责选择；
- [`dbs-content-system`](https://github.com/dontbesilent2025/dbskill/tree/main/skills/dbs-content-system) 把规则、模板、工具和验收说明放在同一 Skill 下；
- 原始知识、提炼后的知识包和执行入口分层，避免一次把所有材料塞进上下文；
- 内容系统用结构化文件和确定性脚本维护来源、去重、链接和处理台账。

不应照搬：

- 大量 Skill 和巨型路由关系；
- 把文件夹结构本身当作 Agent 架构；
- 把宿主模型可能遵循的文字步骤误称为系统级完成保证；
- 在 MVP 中复制完整商业诊断知识库。

### `JimLiu/baoyu-skills`

[`baoyu-skills`](https://github.com/JimLiu/baoyu-skills) 更接近“可执行内容生产工具箱”。代表性 Skill 将 `SKILL.md`、references、scripts、模板、提示词、中间文件和最终产物组织为可恢复流程。

值得借鉴：

- `SKILL.md → references → scripts/assets` 的渐进披露；
- 产物优先：Prompt、中间稿、图片、Markdown、HTML 和完成报告都落盘；
- 长流程拆成阶段，并在高成本或外部动作前设置确认点；
- 脚本负责文件转换、格式检查、图片处理等确定性工作，Model 负责判断与生成；
- [`baoyu-image-gen`](https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-image-gen) 展示了多 Provider 配置，但 Chatty MVP 只需要一个 fixture 或单一 Adapter；
- [`baoyu-post-to-wechat`](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-post-to-wechat/SKILL.md) 将浏览器填充与用户最终发布分开，说明外部动作需要明确的人在回路。

不应照搬：

- 真实小红书、公众号、微博登录与发布；
- 多个图像 Provider、浏览器 Cookie 和平台兼容层；
- 大批内容样式、主题和可配置选项。

### `alchaincyf`

这一组仓库最有价值的是 Skill 的知识压缩、诚实边界和评价方法。

- [`x-mentor-skill`](https://github.com/alchaincyf/x-mentor-skill) 将入口从 769 行压缩为 249 行路由层，操作资料按场景加载，原始研究只在追溯时加载；这证明渐进披露不仅省 token，也会提升执行聚焦度。
- [`nuwa-skill`](https://github.com/alchaincyf/nuwa-skill) 强调来源、交叉验证、反模式和“做不到什么”。它的并行调研不应移植到 Chatty，但来源分级、冲突保留和不确定性值得保留。
- [`darwin-skill`](https://github.com/alchaincyf/darwin-skill) 将 Skill 当作可评价资产，采用 baseline、测试 Prompt、失败模式、检查点、回归比较和人在回路。Chatty 应吸收 evaluation dataset 与失败模式编码，不需要多评委、自动改 Skill 或 Git 爬山循环。
- [`dukou`](https://github.com/alchaincyf/dukou) 展示 Skill 与外部发布能力的区别：Skill 描述工作方法，Adapter 执行外部动作。Chatty 只需 Sandbox export receipt。

## 从 Agent 角度内化这些 Skills

```text
外部 Skill 源码
  → 提炼可复用的方法、失败模式与产物标准
  → 写入 Chatty 固定 instructions / Knowledge / schemas / graders
  → Model 在唯一 Agent Loop 中自主选择固定 Tools
  → Harness 保存 Artifact 并执行 deterministic checks
  → 必要时等待人工 checkpoint
  → 通过后写入 completion receipt
```

内化后的职责：

| 层 | 负责什么 |
|---|---|
| Model | 理解研究或内容任务，选择固定 Tool，处理 Tool result，继续推理与修订 |
| Instructions / Knowledge | 提供从外部 Skill 提炼出的分析方法、平台规则、反模式和诚实边界 |
| Tool / script | 执行检索、保存、结构化计算、格式检查和导出 |
| Harness | 控制权限、Artifact 状态、人工检查点、幂等和完成验证 |
| Eval | 检查 Agent 行为和最终 Artifact，并与无方法约束的 baseline 比较 |

外部 Skill 只在研发阶段作为参考材料存在；产品运行时不知道 `SKILL.md`，也不动态加载第三方能力。

## Chatty MVP 建议

最终定位：

> 综合业务单 Agent：把输入问题和本地资料转成可追溯的产业研究简报，再把已验证结论转成内容方案并完成 Sandbox 交付。

只实现三个固定能力阶段，不把它们暴露为 Skills：

1. Research
   - 使用现有 Knowledge Tool 读取本地 fixture；
   - 区分事实、来源、冲突和推断；
   - 输出 `source-notes.json`。
2. Analyze
   - 从 source notes 提取产业节点、关系、指标和未知项；
   - 输出 `industry-map.json` 与带引用的 `research-brief.md`。
3. Compose
   - 读取已经验证的 research brief；
   - 输出小红书图文、抖音 30 秒脚本和公众号提纲；
   - 输出 `content-pack.md`，不真实发布。

Harness 统一提供：

- `search_knowledge`：复用现有 RAG 与来源记录；
- `save_research_artifact`：保存 source notes、产业图谱和研究简报；
- `save_content_artifact`：保存由已验证研究结论生成的内容包；
- `review_artifact`：运行 schema、引用、必填字段和禁用事实检查；
- `approve_artifact`：只允许可信用户调用；
- `export_artifact`：写入 `delivery-receipt.json`，不连接真实平台。

固定 Demo：

```text
分析高精地图在智能驾驶产业链中的位置
→ Agent 搜索本地 Knowledge 并保存来源笔记
→ 生成 source-notes.json
→ Agent 分析产业节点、关系与指标
→ 生成 industry-map.json + research-brief.md
→ 用户要求生成内容营销方案
→ Agent 只使用已验证研究结论生成内容
→ 生成 content-pack.md
→ grader 发现一条无来源卖点并拒绝
→ Agent 修订
→ 人工批准
→ 生成 delivery-receipt.json
```

这条链路同时展示产业研究、内容生产、内化方法的跨阶段复用、RAG、Artifact、人在回路和自动评测；不需要真实高德数据接口、真实媒体发布或 Multi-Agent。

## 最小数据模型

- `Artifact`：id、type、version、path、source artifact IDs、status；
- `ReviewReceipt`：artifact、grader results、decision、actor；
- `DeliveryReceipt`：artifact、target=`sandbox`、hash、deliveredAt；
- 复用现有 Session、Trace 和 Knowledge。

不新增通用 Workflow、Graph database、Vector database、Plugin marketplace 或多租户模型。

## Eval

最小 evaluation dataset 覆盖：

1. Model 能自主选择正确的研究、分析或内容 Tool；
2. 普通问答不会写入 Artifact；
3. 只检索与任务相关的方法和资料；
4. 研究数字必须有来源；
5. 证据冲突必须保留，不得静默覆盖；
6. 内容卖点不得超出 research brief；
7. 未审核 Artifact 不能 export；
8. 相同 export 使用幂等 receipt；
9. Adapter/check 失败时不得声称已交付；
10. 内化方法后的 Agent 相比普通 Prompt baseline，在完整度和引用有效性上有可复现提升。

## 增量检查点

1. M0：冻结当前客服版本、SQLite 备份和现有 eval；
2. M1：将筛选后的方法内化到 instructions、Knowledge 与 eval dataset，不增加运行时抽象；
3. M2：实现 Artifact、review、approval、sandbox delivery receipt；
4. M3：实现 Research、Analyze、Compose 固定 Tools、fixture 与 deterministic eval；
5. M4：Next.js 只增加 Artifact preview 和 approval；
6. M5：完整 E2E 通过后归档 Commerce/Orders，保留代码与数据库回滚点。

每个里程碑继续运行 lint、test、typecheck、build、eval 与 focused E2E；真实 Provider 只做一次最终 smoke。

## 明确不做

- Multi-Agent、subagent、team protocol；
- 真实高德、小红书、抖音或公众号接口；
- 通用工作流编辑器、DAG、cron、队列；
- Skill catalog、`load_skill` 和动态安装第三方 Skill；
- Skill 商店、Skill 编排和多运行时兼容层；
- 自动优化 Skill、独立评委群和自动 Git rollback；
- 图数据库、向量数据库和完整金融估值平台；
- 真实视频批量生成。

## 判断标准

MVP 成功不是“仓库里支持多少 Skills”，而是：

1. Trace 能证明 Model 自主选择了研究、分析和内容 Tools；
2. 相同 Agent Loop 能连续完成投研和内容两个差异明显的 Artifact；
3. Harness 能拒绝无来源、未审批或未真正 export 的结果；
4. evaluation dataset 能证明内化的方法与约束带来稳定提升；
5. 最终代码仍能让读者在较短时间内看懂 Agent loop、Tool Use 和 completion verification。
