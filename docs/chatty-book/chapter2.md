# 第 2 章：Context 如何流动

Model 每次只能根据当前收到的 Context 作出判断。对 Chatty 来说，Context 不只是一句用户原话，还包括会话历史、当前请求约束和 Tool Result。

用户输入首先经过 `parse_need`。它把自然语言转换成结构化条件：

```text
“我要一个 300 元的蓝牙耳机”
  → preferred_categories = ["耳机"]
  → max_price_cents = 30000
```

这里把“300 元的”理解为预算上限；“300 元以上”才表示下限，“200 到 300 元”表示区间。价格统一转换成分，后续代码不再处理模糊的中文金额。

随后，`Conversation` 把当前请求和之前的消息保存成 Agents SDK 使用的结构化历史。用户消息、模型输出和 Tool 调用保持各自的类型，而不是被拼成一段长文本。这样第二轮对话仍能知道哪些内容来自用户，哪些内容来自模型。

Tool 执行后会产生两份不同用途的输出：

```text
Tool Result
  ├→ model：进入下一轮 Model Context
  └→ evidence：只留在 Harness
```

Model 可以看到商品列表、库存状态和知识内容，从而继续推理。Harness 另外保存召回过哪些商品、检查过哪些库存、哪些商品有知识支撑。这份 Evidence 不需要交给 Model，因为它的用途是最终校验，而不是帮助生成文字。

Chatty 的会话最多三轮，并保存在服务端内存中。这个范围不需要上下文压缩或长期轨迹系统：会话结束或服务重启后，临时历史自然消失。

DeepSeek Responses API 不负责保存 Chatty 的业务会话。结构化 history 由服务端内存和
Harness 管理，因此这里不依赖 `previous_response_id`。

不同 Context 的位置和生命周期如下：

| Context | 所在位置 | 生命周期 |
| --- | --- | --- |
| `said / history / turns` | FastAPI 进程内存 | 一段会话，重启后消失 |
| Evidence 与 Tool trace | Agents SDK RunContext | 每轮重新创建，不跨轮复用 |
| 商品、库存、知识与画像 | SQLite | 运行时业务事实 |

如果准备顺着代码阅读，可以按下面的文件表进入：

| 层 | 文件 | Context In | Context Out |
| --- | --- | --- | --- |
| HTTP | `backend/app/api.py` | 用户原话、会话 ID | recommend / clarify / exhausted |
| 输入适配 | `backend/app/need_parser.py` | 用户原话、可选类目 | `UserContext` |
| 会话 | `backend/app/conversation.py` | 累积话语、history | 一轮回复、新 history |
| Agent/Harness | `backend/app/agent.py` | `RecommendationRequest` | 可信推荐或稳定错误码 |
| Tool | `backend/app/tools.py` | Tool 参数、RunContext | Model Result 与 Evidence |
| 数据与检索 | `backend/app/catalog.py` | 结构化查询 | SQLite 事实与知识命中 |
