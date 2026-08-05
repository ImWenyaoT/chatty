---
status: accepted
---

# 加一个 Web 对话界面和它需要的 HTTP 层

原先的项目边界写着「不增加前端、外部数据库或向量数据库」，理由是一个月的 MVP 要控重量。
随着项目转为简历展示，交互入口改为 Web GUI；不再维护 CLI/TUI 作为第二套产品形态。

现在反转前半条：**加一个 Web 对话界面（`frontend/`，Vite + React + TypeScript）和一个
FastAPI HTTP 层（`backend/app/api.py`，现为 `server/src/api.ts`，见 [ADR 0003](0003-typescript-migration.md)）**。后半条不变——外部数据库和向量数据库仍然不加。

反转的理由是受众。Web GUI 能直接展示多轮澄清、推荐卡片和错误状态，避免要求体验者理解
命令行协议。这对一个用来展示工程判断的项目是有分量的差别，不是「好看一点」。

## 由此产生的两个决定

**会话状态存在服务端内存里，不落 SQLite。** SQLite 在这个项目里的职责是「演示业务数据 +
知识检索」，加一张会话表就是给它加第二种职责。演示场景重启丢会话可以接受；真要持久化，
那时再单独决定。

**Chatty Agent 提供一轮入口 `run()`，而不是让 HTTP 层自己拼历史。**
HTTP 是一轮一个请求；若让 HTTP 层绕开 Chatty Interface 直接调 Model，
就会把 `{"action":"clarify"}` 协议形状和会话历史拼装分散到多个调用方。
所以 `Chatty.run()` 承担一轮，`ChattyContext` 保存会话状态，协议仍然只有一份。

## 不变的边界

- Web GUI 是唯一用户交互入口；HTTP 层只把请求交给 `Chatty.run()`，不复制业务逻辑。
- 前端不引 web font，用系统字体（CJK 为主，web font 体积不划算）。
- 前端不碰业务事实：商品、价格、库存仍然只从 SQLite 重查后由后端给出。
