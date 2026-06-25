# QA 模板说明

这个文件是说明文档，不建议直接入库。

当前系统的严格规则是：

1. 只有 `.csv` 文件会被识别为 QA。
2. CSV 必须只有两列：`question,answer`。
3. 其他格式例如 `.md`、`.txt`、`.json`，全部按普通文本入库。

真正用于入库的 QA 文件，建议像 [docs/history/qa-examples.csv](/Users/snoopy/Documents/vscode/Dify/rag-service/docs/history/qa-examples.csv) 那样保存。

## 严格模板

```csv
question,answer
用户问题1,标准回答1
用户问题2,标准回答2
```

## 严格要求

1. 第一行必须是 `question,answer`。
2. 每一行只能有两列，不能多列也不能少列。
3. question 和 answer 都不能为空。
4. 如果内容里本身包含逗号，必须使用 CSV 标准双引号包裹。
5. 不要在 QA CSV 里加入标题、说明、空行说明、章节名。

## 正确示例

```csv
question,answer
可以先寄来试穿，不合适再退吗？,线上订单寄出后视为开始出租，不支持先寄出再试穿。
租期是从什么时候开始算？,一般从客户签收当天开始计算，到约定归还日期寄回即可。
```

## 含逗号时的正确示例

```csv
question,answer
"我身高172，体重65kg，适合穿什么码？","需要结合具体商品版型进一步判断，一般建议先提供身高、体重、肩宽和穿着场景。"
```

## 错误示例

```text
Q: 可以先寄来试穿吗？
A: 不支持。
```

上面这种虽然是问答，但现在会被当成普通文本，不再按 QA 处理。

## 建议做法

1. QA 一律放在 `docs/history/*.csv`
2. 规则一律放在 `docs/rules/*`
3. 商品说明一律放在 `docs/products/*`