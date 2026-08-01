import { Catalog } from "./catalog.js";

const cases = [
  ["降噪 耳机 通勤", ["耳机"], ["P003", "P004"], ["K001", "K002", "K003"]],
  ["咖啡机 胶囊", ["家电"], ["P018"], ["K030", "K009"]],
  ["平板 学习 办公", ["平板"], ["P005", "P006"], ["K005", "K020", "K021"]],
  ["笔记本 轻薄 办公", ["电脑"], ["P030"], ["K013", "K022"]],
  ["跑鞋 竞速 训练", ["运动"], ["P040", "P016"], ["K027", "K007"]],
  ["安静 静音 耳机", ["耳机"], ["P003", "P004"], ["K001", "K002", "K003"]],
  ["保护视力 不伤眼", ["家电"], ["P019"], ["K031"]],
  ["电池耐用 一天一充", ["穿戴"], ["P031", "P032"], ["K015", "K024"]],
  ["快充 充电器", ["配件"], ["P007"], ["K006", "K036"]],
  ["价格敏感 沟通 原则", ["营销"], [], ["K010"]],
] as const;
const catalog = new Catalog();
let hits = 0,
  mrr = 0;
try {
  for (const [query, categories, products, relevant] of cases) {
    const ids = catalog
      .retrieveKnowledge({
        query,
        categories: [...categories],
        product_ids: [...products],
        limit: 5,
      })
      .map((hit) => hit.doc_id);
    const rank = ids.findIndex((id) => relevant.some((value) => value === id));
    if (rank >= 0) {
      hits += 1;
      mrr += 1 / (rank + 1);
    }
  }
  console.log(
    JSON.stringify(
      {
        cases: cases.length,
        recall_at_5: hits / cases.length,
        mrr: Number((mrr / cases.length).toFixed(4)),
      },
      null,
      2,
    ),
  );
} finally {
  catalog.close();
}
