/**
 * 把用户原话转换为简单、可校验的 TaskFrame。
 *
 * 这个文件只负责“理解用户要做什么”，不搜索商品、不查库存、也不生成最终回复。
 * TaskFrameWire 是 Model 输出的临时形状；TaskFrame 是 Harness 真正使用的领域对象。
 * 二者分开后，外部 Model 的格式限制不会污染后面的业务代码。
 */

import {
  Agent,
  extractAllTextOutput,
  type RunErrorHandlerInput,
  type RunErrorHandlerResult,
} from "@openai/agents";
import { z } from "zod";

import type { ProductNeed, TaskFrame, UserContext } from "../data/models.ts";
import {
  emptyUserContext,
  productNeedSchema,
  taskFrameSchema,
} from "../data/models.ts";
import type { ModelProvider } from "../model-provider.ts";
import { round } from "../data/round.ts";

/**
 * DeepSeek Responses API 可接受的扁平 structured output。
 *
 * 数组最多只有一个元素，是为了兼容 provider 的 structured output 能力。
 */
export const taskFrameWireSchema = z.object({
  product_requested: z.boolean(),
  category: z.array(z.string()).max(1),
  min_yuan: z.array(z.number().min(0)).max(1),
  max_yuan: z.array(z.number().min(0)).max(1),
  knowledge_query: z.array(z.string()).max(1),
});
export type TaskFrameWire = z.infer<typeof taskFrameWireSchema>;

/** 模型返回的 TaskFrame 无法安全映射到当前业务数据。 */
export class TaskFrameParseError extends Error {}

/** 把 SQLite 中真实存在的商品类目写入 Task Framer Instructions。 */
export function taskFrameInstructions(categories: readonly string[]): string {
  // join 把 ["耳机", "键盘"] 变成适合给 Model 阅读的“耳机、键盘”。
  const categoryText = categories.join("、");
  return (
    "把整段用户对话整理成一个结构化 TaskFrame。" +
    "TaskFrameWire 是扁平结构，所有字段都必须填写。" +
    "用户要求推荐、查找或比较商品时，product_requested=true；否则为 false。" +
    "category、min_yuan、max_yuan 和 knowledge_query 都是最多一个元素的数组；" +
    "对应内容不存在时填写空数组。" +
    "单个价格默认是上限；以上或起是下限；到或至才同时填写区间。" +
    "用户询问快递、退换货等已有规则或事实时，把适合检索的简短表达填入" +
    "knowledge_query；没有知识问题时填空数组。混合请求必须同时保留两部分。" +
    "后续短回答用于补充前文，最新的明确约束覆盖旧约束。" +
    `商品可选类目：${categoryText}。` +
    "不要创建 intent、goal、route 或支付相关字段。"
  );
}

/** 使用 Agents SDK structured output 声明 TaskFrame 契约。 */
export function buildTaskFrameAgent(
  provider: ModelProvider,
  categories: readonly string[],
) {
  return new Agent({
    name: "Chatty Task Framer",
    instructions: taskFrameInstructions(categories),
    model: provider.agentModel,
    outputType: taskFrameWireSchema,
    modelSettings: { reasoning: { effort: "none" } },
  });
}

export type TaskFrameAgent = ReturnType<typeof buildTaskFrameAgent>;

/** 兼容 DeepSeek 把 structured output 包在 properties 中的响应。 */
export function recoverInvalidTaskFrame(
  data: RunErrorHandlerInput<unknown, TaskFrameAgent>,
): RunErrorHandlerResult<TaskFrameAgent> {
  const wire = parseTaskFrameWireOutput(
    extractAllTextOutput(data.runData.newItems),
  );
  return { finalOutput: wire };
}

/** 只在 invalidFinalOutput 路径解开 DeepSeek 的 properties 包装。 */
export function parseTaskFrameWireOutput(raw: string): TaskFrameWire {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TaskFrameParseError("invalid_task_frame_output");
  }
  // JSON.parse 的结果类型是动态的，所以先缩小到带 properties 的对象。
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskFrameParseError("invalid_task_frame_output");
  }
  const properties = (value as Record<string, unknown>)["properties"];
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    throw new TaskFrameParseError("invalid_task_frame_output");
  }
  // parse 在运行时检查 boolean、数组以及长度和最小值。
  const parsed = taskFrameWireSchema.safeParse(properties);
  if (!parsed.success)
    throw new TaskFrameParseError("invalid_task_frame_output");
  return parsed.data;
}

/** 校验动态业务边界；不根据关键词在 Harness 中再次猜测语义。 */
export function parseTaskFrame(
  frame: TaskFrameWire,
  categories: readonly string[],
): TaskFrame {
  // Wire 用空数组表示“没有值”；领域对象统一改成更直接的 null。
  const category =
    frame.category.length > 0 ? frame.category[0]!.trim() || null : null;
  const minYuan = frame.min_yuan.length > 0 ? frame.min_yuan[0]! : null;
  const maxYuan = frame.max_yuan.length > 0 ? frame.max_yuan[0]! : null;

  let productNeed: ProductNeed | null;
  if (frame.product_requested) {
    // category 必须来自 SQLite 提供的当前类目，Model 不能发明不存在的类目。
    if (category !== null && !categories.includes(category)) {
      throw new TaskFrameParseError("invalid_product_category");
    }
    if (minYuan !== null && maxYuan !== null && minYuan > maxYuan) {
      throw new TaskFrameParseError("invalid_product_price_range");
    }
    const need = productNeedSchema.safeParse({
      category,
      min_yuan: minYuan,
      max_yuan: maxYuan,
    });
    if (!need.success)
      throw new TaskFrameParseError("invalid_product_price_range");
    productNeed = need.data;
  } else {
    // Model 说“不需要商品”时，不允许同时偷偷带上类目或价格。
    if (category !== null || minYuan !== null || maxYuan !== null) {
      throw new TaskFrameParseError("product_fields_without_request");
    }
    productNeed = null;
  }

  // 空字符串也归一化成 null，后续只需要判断 `!== null`。
  const knowledgeQuery =
    frame.knowledge_query.length > 0
      ? frame.knowledge_query[0]!.trim() || null
      : null;
  const parsed = taskFrameSchema.safeParse({
    product_need: productNeed,
    knowledge_query: knowledgeQuery,
  });
  if (!parsed.success) throw new TaskFrameParseError("empty_task_frame");
  return parsed.data;
}

/** 把 TaskFrame 中的商品需求转换为 Catalog 使用的搜索条件。 */
export function productContext(need: ProductNeed): UserContext {
  // UserContext 给出安全默认值，因此先创建空对象，再复制用户明确说出的字段。
  const context = emptyUserContext();
  if (need.category !== null) context.preferred_categories = [need.category];
  // 对外展示使用“元”，SQLite 整数价格使用“分”，避免浮点金额误差。
  if (need.min_yuan !== null)
    context.min_price_cents = round(need.min_yuan * 100);
  if (need.max_yuan !== null)
    context.max_price_cents = round(need.max_yuan * 100);
  return context;
}

/** 把结构化 TaskFrame 转回简短中文，供 UI 展示“理解为”。 */
export function describeTaskFrame(frame: TaskFrame): string {
  // parts 按需加入类目、价格和知识问题，最后用中点连接。
  const parts: string[] = [];
  const need = frame.product_need;
  if (need !== null) {
    parts.push(need.category || "不限类目");
    if (need.min_yuan !== null) parts.push(`≥${round(need.min_yuan)} 元`);
    if (need.max_yuan !== null) parts.push(`≤${round(need.max_yuan)} 元`);
  }
  if (frame.knowledge_query) parts.push(`知识 · ${frame.knowledge_query}`);
  return parts.join(" · ");
}
