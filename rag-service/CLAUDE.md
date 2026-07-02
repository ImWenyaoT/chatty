# CLAUDE.md — 接力上下文

> 给下一个 Claude Code 会话用的速查文档。**不重复 [README.md](./README.md) / [ARCHITECTURE.md](./ARCHITECTURE.md) 的内容**，只记录会话间会丢失的上下文：当前在做什么、外部依赖在哪、踩过哪些坑。

---

## 1. 当前开发焦点（2026-04 最新）

**主线**：把外部"闲鱼 intel API"接入 rag-service，作为买家身份/订单/历史聊天的事实数据源。

之前 rag-service 是孤立服务，靠 `/chat` 入参 + `memory-store.json` 维护客户档案。现在新增了一条数据通路：上游 APK 抓取的真实闲鱼会话/订单/消息，可以通过 HTTP 拉到。

**接入还没动代码**，目前只完成接口验证 + 数据探查。下一步的可能动作（按优先级）：

1. 在 `/chat` 进入流程前，按 `customerId` / `sessionId` 调一次 intel API，把 `buyer_order_history` 和 `messages` 注入到 stylist 的 system prompt 或 memory.profile 里，作为"事实底座"
2. 用 intel 的 `is_repeat_buyer` + `buyer_order_history` 做"老客户回头单"豁免——绕过 MEMORY 里那条"款式未确认前不进入档期/体型流程"的硬规则（详见 §3）
3. 用 intel 的 `quoted_text` / `main_text` 拆分结果替代当前 `parsers/measurements.ts` 里对引用回复的 ad-hoc 处理

---

## 2. 外部 intel API（数据源，新）

### 服务定位

| | |
|---|---|
| 服务进程 | `uvicorn main:app --host 0.0.0.0 --port 8000 --reload` |
| 工作目录 | `/Users/snoopy/Documents/vscode/tamperfish_snoopy_20260423/tamperfish_bundle_v2/backend/` |
| 库文件 | `tamperfish.db`（SQLite，APK 抓取写入） |
| 静态资源 | `static/crops/*.png`（聊天截图/商品图/物流截图，HTTP 公开） |

**这是独立项目，不在 rag-service 仓库内。** 部署时要保证 8000 端口可达；如果换部署形态需要协调上游团队。

### 主接口

```
GET  http://localhost:8000/api/ui/sessions/{id}/intel
Header: x-api-key: dev-key-change-me
Query: include_messages=true (default)
       messages_limit=200 (default, max 1000)
       include_history=true (default)
```

辅助：

```
GET  http://localhost:8000/api/ui/sessions
       └─ 列所有 session（无需 detail；列表里给 buyer_nickname / item_id / last_message_preview）
GET  http://localhost:8000/static/crops/{filename}
       └─ 拉聊天图片，无需 api-key，content-type=image/png
```

### Response schema (schema_version=1)

```jsonc
{
  "schema_version": 1,
  "generated_at": <epoch>,
  "session": {
    "id", "device_id", "shop_name",
    "buyer_nickname_masked",       // "a***w" 闲鱼平台显示的掩码版
    "buyer_nickname_unmasked",     // "爱吃托烧豆腐的柑橘" 从 item_title 的 "TA买过你的宝贝 X" 前缀剥出来
    "is_repeat_buyer",             // bool，由 chat label 判定
    "item_id", "item_title_chat_label", "product_title", "item_price",
    "item_thumbnail_ref", "order_status",
    "last_message_at/preview/sender", "unread_count", "list_index", "updated_at"
  },
  "buyer": {
    "nickname_masked", "nickname_unmasked", "xianyu_id",
    "profile_info" (auto JSON-decoded), "updated_at"
  },
  "current_inquiry": { "item_id", "product_title", "item_price", "item_thumbnail_ref" },
  "messages": [
    { "id", "sender" /* buyer|seller */, "kind" /* text|image */,
      "text",                       // raw, 可能 quote-reply 拼了换行
      "image_ref",                  // /static/crops/xxx.png
      "quote_image_ref",
      "displayed_time", "sent_at",  // sent_at 偶尔为 null，排序时注意
      "read_status", "send_status",
      "main_text", "quoted_sender", "quoted_text"  // 已拆好的 quote-reply
    }
  ],
  "messages_truncated": bool,
  "buyer_order_history": [          // 按 placed_at DESC，包含买家全部订单
    { "id", "order_no", "tab", "title", "status", "item_id",
      "buyer_nickname", "buyer_phone", "ship_address",
      "order_amount", "paid_amount", "deposit_amount", "rent_fee",
      "rent_period", "rent_start_at", "rent_end_at",
      "placed_at", "paid_at", "shipped_at",
      "return_courier", "return_tracking_no", "return_tracking_info",
      "is_current_inquiry": bool   // 当前 session.item_id 命中标记
    }
  ],
  "buyer_order_history_count": N
}
```

### 设计要点（外部团队约定）

- **`*_masked` / `*_unmasked` 后缀**显式标 mask 状态：跨表 join 时，orders 表用 `unmasked`、buyers 表用 `masked`。错用 join 不上。
- **`is_current_inquiry`**：每条历史订单上自带，rag-service 不用再算"哪一单是这次咨询的"。
- **`schema_version`**：兜底未来 breaking change。读取时建议 `if schema_version != 1 then warn`。
- **api key auth**：endpoint 暴露买家私聊 + 订单数据，**不要把 dev-key 写死到客户端**；接入 rag-service 时从 env 读。
- **`profile_info` 已自动 JSON decode**，外部不用再 parse。

### 已知边界 / 需要在客户端处理

- `image_ref` / `quote_image_ref` / `item_thumbnail_ref` 都是相对路径 `/static/crops/...`，要在客户端拼 base URL。拉图无需 api-key。
- 历史订单偶尔出现 `item_id="null"`（**字符串字面值**），如 "运费差价补偿服务" 这类工单单。按 item_id 过滤要排除掉这种值。
- `messages` 里 `sent_at` 早期消息可能为 `null`（APK 抓取时未拿到时间），按 sent_at 排序时空值会被推到最前——**不要假设单调递增 epoch**。
- `messages` 里 `kind` 当前只见过 `text` / `image`，未见语音/卡片/系统消息。如果上游加新 kind，schema_version 那个兜底就用上。
- **同一 buyer 可能用多账号**：session 63 里出现 "刚刚181.70公斤的那个，换个账号拍" — 单纯用 `nickname_unmasked` 做 join 判 "是否回头客" 会漏。

---

## 3. 实测对话数据观察（接入策略相关）

会话期间扫了 12 个真实 session，对身高体重 / 档期 / 款式确认率做的统计：

| 信息齐全度 | session | 备注 |
|---|---|---|
| **三件套齐**（身高体重 + 档期 + 款式） | 39 / 56 / 63 / 66 | 健康样本 |
| **走完支付/发货但身体数据没问** | 54 / 62 / 46 | **老客户回头单**，靠 buyer 历史档案而非当次对话补尺码 |
| **0 消息但有订单** | 49 / 51 | 仅靠订单历史推断，纯历史 session |
| **卡在款式咨询** | 41 | 还没触发尺码/档期流程 |

**对当前 rag-service 业务规则的冲击点**（参考 MEMORY 中 `project_rag_service_flow.md`）：

> 现有规则："客户未确认款式前所有追问都围绕款式，不能进入档期/体型/尺码流程"

这条规则对 session 62 这种**老客户回头单**会反复追问"您要哪款"——但其历史订单里已经明确租过同款蓝色/杏色西装。

接入 intel 后建议加豁免：

```
if buyer.is_repeat_buyer && current_inquiry.item_id ∈ buyer_order_history.item_id:
    跳过款式确认，直接进档期/体型流程
```

**单位陷阱**（解析端要处理）：

- 39 用"斤"（179, 157斤）
- 56 公斤 / 斤混用，且最后一条卖家复述时显式纠正
- 63 出现 "181.70公斤" 这种**用户用句号自己拼的写法**（实际是 181cm 70kg）

→ `parsers/measurements.ts` 抽取时要 (a) 区分单位 (b) 优先信任**消息序列里最晚的一条卖家复述**（因为客服会显式确认）。

---

## 4. 验证 intel API 是否在线（接力时第一件事）

```bash
# 列 sessions
curl -s http://localhost:8000/api/ui/sessions \
  -H "x-api-key: dev-key-change-me" | head -100

# 任选一个 id 拉详情
curl -s "http://localhost:8000/api/ui/sessions/63/intel?messages_limit=10" \
  -H "x-api-key: dev-key-change-me" | python3 -m json.tool
```

如果返回 401 → api key 改了，去问上游。
如果连接拒绝 → uvicorn 没起，去 `tamperfish_bundle_v2/backend/start.sh`。
如果 schema_version != 1 → 上游改 schema 了，先看 schema 再接。

---

## 5. 端口 / 服务清单

| 端口 | 服务 | 来源 | 用途 |
|---|---|---|---|
| 3001 | rag-service (Fastify) | 本仓库 | `/chat` + Dashboard |
| 8000 | tamperfish backend (uvicorn) | `tamperfish_bundle_v2/backend/` | intel API + 静态截图 |
| 5173 | dashboard dev (Vite) | `dashboard/` | 仅 `pnpm dev:dashboard` |
| 6333 | Qdrant | docker | 向量库（可选） |
| 5000 | macOS ControlCenter | 系统 | **占用注意**，rag-service 不要选 5000 |

---

## 6. 接力 checklist

进入新会话时建议先：

1. `lsof -i :8000 -P | grep LISTEN` 确认 intel 服务在跑
2. `cat config/prompts/v1.yaml | head -50` 确认硬规则版本
3. `git log --oneline -10`（如果在 git 仓内）看最近改动
4. 跑 `pnpm eval` 看金标基线没崩
5. 读 [README.md §11.2](./README.md) 看待办遗留项

新会话头一句话要做的事，**不在这个文档里写死**——按用户当次需求执行。这个文档只解决"上下文丢失"问题。
