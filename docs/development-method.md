# Chatty Development Method

本文件把 Chatty 的工程方法固定下来：下限贴 `docs/jd.md`，上限只允许 `openclaw`、`codex`、`claude-code`。删除比优化重要；低于下限或超出上限的代码优先删除、归档或收束。

## 1. 参考实现三选一

每次改 harness、agent loop、tool calling、memory、skills、MCP、eval、trace 或 LLM 账单/缓存相关能力时，先做参考实现三选一：

| 能力类型 | 默认主参考 | 采用边界 |
| --- | --- | --- |
| Agent loop、tool scheduling、tool use、trace、eval、KV cache/cost | `codex` | 只采用有界 loop、可观测 trace、usage/budget 和 cache-friendly prompt 布局 |
| Memory、长期状态、用户画像/事实沉淀 | `openclaw` | 只采用能解释 demo 的最小 memory 结构，不扩成通用知识平台 |
| Skills、plugins、MCP 配置体验 | `claude-code` | 只采用清晰入口、显式能力边界和用户可理解的配置方式 |

单次能力只能选一个主参考。可以阅读另外两个，但不能把三者都写成设计依据；如果实现需要混合，先拆成更小能力再分别选择。

## 2. 实现前检查

开始编码前写下四句话，放进 `docs/changelog.md` 或相关设计文档：

1. JD 对齐：这项能力解决 `docs/jd.md` 里的哪一句。
2. 主参考：本次三选一选了哪个参考源。
3. 采用内容：具体模仿了什么行为、结构或约束。
4. 拒绝内容：哪些低于下限或超出上限的东西不做。

如果四句话写不清，先不要改代码。

## 3. 搭积木复现法

调试时按从小到大的块复现，不直接在完整 demo 里猜：

1. 最小输入：构造一个能触发问题的最小 request、prompt、tool result、trace 或 UI 状态。
2. 单块验证：只跑一个 public seam，例如 parser、policy、tool adapter、route handler、model adapter 或页面契约。
3. 组合验证：单块绿了以后再组合到 harness step、route、smoke 或 browser demo。
4. 自动化回归：把曾经失败的最小块留下测试；真实 LLM 行为进 eval 或 trace review，不只靠手测。

## 4. 结束标准

一次改动结束时至少回答：

- 是否仍在 `docs/jd.md` 和三个参考源之间。
- 是否有一个清楚的主参考，而不是泛泛参考多个项目。
- 是否删除了低价值或越界复杂度。
- 是否有自动化测试覆盖可验证行为。
- 是否更新了 `docs/design.md`、`docs/changelog.md` 或本文件中受影响的契约。
