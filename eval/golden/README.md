# harness 版金标场景（B4）

本目录是 `pnpm eval` 读取的金标场景集（harness lane，唯一活路径）。legacy 版
场景集与 legacy lane 已随整个 rag-service 于 R5 删除。每个 YAML 头部注释仍逐场景保留与当年
legacy 版的语义等价性说明作为溯源（映射依据 §5.3：质量不变量→行为断言；可映射的
action→harness action kind 映射表；其余逐场景定夺）。

## action 映射表（§5.3 初表 + B4 定夺项）

| legacy action | harness action kind | 依据 |
|---|---|---|
| ask_product / ask_schedule / ask_body | ask_missing_info | §5.3 映射表 |
| answer_faq / rental_howto / quote_price / current_link_confirm | answer_question | §5.3 映射表 |
| size_recommend | recommend_size | §5.3 映射表 |
| handoff | handoff | §5.3 映射表 |
| ack_rental_period | ask_missing_info | B4 定夺：确认档期后继续收集体型，同属信息收集形态 |
| confirm_size / confirm_review / guide_order | actionIn [recommend_size, check_availability, answer_question]（或行为断言） | B4 定夺："三要素齐了就推进"的三种形态 |
| greet / small_talk / recall_body_empty / repair | 无映射，行为断言表达 | B4 定夺：无 harness 对应词汇，真实契约行为化（见各 YAML 注释） |

stage/stageIn 断言一律行为化改写（harness 没有 orchestrator 状态机，
runner 对 harness 场景里出现 stage/profile 断言直接判 FAIL，防静默跳过）。

## profile 断言豁免清单（blocked-on-§16，§5.5）

profile 断言依赖"profile 写路径迁 SQLite"（loop-engineering-plan §16 🟡 项），
不在 agentic-search 设计范围内。以下断言在 harness 版中删除并在平价判定中
豁免——豁免不是删除，§16 闭环后按此清单回补：

| 场景 / step | 豁免的 legacy 断言 |
|---|---|
| all-in-one / step1 | profile.heightCm=175, weightKg=70, rentalPeriod.startDate/endDate="*" |
| happy-path / step3（4月29号到30号用） | profile.rentalPeriod.startDate/endDate="*" |
| happy-path / step4（身高180 体重70kg） | profile.heightCm=180, weightKg=70 |
| rental-period-provide / step2 | profile.rentalPeriod.startDate/endDate="*" |

recentMessages 可表达的部分（§5.3）经逐场景核查为零：上述断言全部指向
slot 抽取结果（heightCm/weightKg/rentalPeriod），用户原话本来就在
recentMessages 里，改写成消息包含断言等于恒真，无信息量，故不改写、只豁免。

## 检索必答场景（§5.4，不计入 11/11 退役门槛）

store-contact / size-exchange-policy / deposit-cleaning 三个场景的事实只存在
于 knowledge/ 语料（店铺信息为仓库占位符值，非真实信息），是 FTS5 索引 +
search_knowledge 工具 + 有界循环全链路的端到端闸门：检索缺失时必然 FAIL。
B5 达标验收要求其 PASS。
