# 第 9 章：中文 Web GUI

Chatty 只保留 Web GUI 这一种用户入口。用户不需要学习命令行参数，只要选择一个演示画像，再用中文描述购物需求。

界面展示五种画像：活跃用户、价格敏感用户、高价值用户、新用户和流失风险用户。中文名称只用于展示，HTTP 请求和数据库仍使用 `user_active`、`user_budget` 等稳定英文 ID。

一轮请求会依次显示：

1. 用户原话；
2. 输入适配器理解出的类目与价格；
3. Agent 的澄清问题或商品卡片；
4. 商品价格、库存与 Harness 校验说明。

前端不计算推荐分数，也不修正价格和库存。它只调用 HTTP API 并渲染后端返回的结果，所有业务规则仍然位于 Agent、Harness 和 Catalog 中。

React GUI 是产品界面，不是多模态 Agent。Model 不会观察屏幕、点击按钮或理解图片；Chatty 当前处理的输入和输出都是文字与结构化数据。只有未来确实需要语音、图片或屏幕操作时，才需要扩展新的观察与行动空间。

前端入口位于 `frontend/src/App.tsx`，HTTP 类型位于 `frontend/src/api.ts`，后端接口位于 `backend/app/api.py`。
