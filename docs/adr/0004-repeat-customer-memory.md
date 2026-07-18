# 长期客户记忆只服务复购

- 状态：Accepted（2026-07-18）

Chatty 对所有客户保留完成当前交易所需的 Transaction Context 和可审计 Trace，但只有在第二个已支付或已确认订单成立后，客户才获得 Long-term Customer Memory 资格。此前的第二次咨询、待支付订单或重复打开会话都不触发长期记忆；资格成立后，历史 Trace 可以作为来源证据。客户明确陈述的稳定事实或偏好可在带 `sourceTraceId` 时提升，Model 推断只能作为 Memory Candidate，经过客户确认、重复证据或人工审核后才能提升；一次性交易需求始终留在 Transaction Context。
