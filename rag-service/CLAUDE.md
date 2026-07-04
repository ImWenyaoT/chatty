# CLAUDE.md — 接力上下文

> 给下一个 Claude Code 会话用的速查文档。**不重复 [README.md](./README.md) / [ARCHITECTURE.md](./ARCHITECTURE.md) 的内容**，只记录会话间会丢失的上下文：当前在做什么、外部依赖在哪、踩过哪些坑。

---

## 1. 当前开发焦点（2026-07 最新）

**主线**：rag-service 已定位为冻结的 legacy lane（权威架构见根目录 docs/architecture.md，
迁移账本见 docs/loop-engineering-plan.md §16）。当前焦点是 eval 迭代
（金标 11/11 基线维护、failure_case→golden 晋升闭环）与向 packages/* 新 loop 的保守迁移。
src 代码本体不动，按 RW-1 计划整目录最终从 main 删除。

## 2. 已搁置：外部闲鱼 intel API 接入（2026-04）

曾计划把上游 APK 抓取的闲鱼会话/订单数据（tamperfish backend，另一台 Mac 上的独立项目）
作为买家事实数据源接入 `/chat`。接口验证过、未动代码，随 legacy 冻结一并搁置。
完整的 response schema、curl 验证步骤、12 个真实 session 的数据观察见本文件 git 历史
（`git log --follow -- rag-service/CLAUDE.md`）。留给后来者的两条实测结论：

- 体型解析要防单位陷阱：斤/公斤混用、"181.70公斤"（实为 181cm 70kg）这类句号拼写法——
  `parsers/measurements.ts` 的处理逻辑因此而来，优先信任消息序列里最晚的卖家复述。
- 老客户回头单靠历史订单补尺码，"款式未确认前不进档期/体型流程"的硬规则对其会误追问。

## 3. 端口 / 服务清单

| 端口 | 服务 | 来源 | 用途 |
|---|---|---|---|
| 3001 | rag-service (Fastify) | 本仓库 | `/chat` + 手动测试页 |
| 6333 | Qdrant | docker | 向量库（可选） |
| 5000 | macOS ControlCenter | 系统 | **占用注意**，rag-service 不要选 5000 |

## 4. 接力 checklist

进入新会话时建议先：

1. `cat config/prompts/v1.yaml | head -50` 确认硬规则版本
2. `git log --oneline -10` 看最近改动
3. 跑 `pnpm eval` 看金标基线没崩
4. 读 [README.md §11.2](./README.md) 看待办遗留项

新会话头一句话要做的事，**不在这个文档里写死**——按用户当次需求执行。这个文档只解决"上下文丢失"问题。
