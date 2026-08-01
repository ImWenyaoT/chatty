import type { ModelProvider } from "./model-provider.js";
import { emptyContext, type UserContext } from "./types.js";
const prompt = (categories: string[]) =>
  `把购物需求转成 JSON，只输出 JSON：{"category":"类目或 null","min_yuan":数字或 null,"max_yuan":数字或 null}。可选类目：${categories.join("、")}`;
export async function parseNeed(
  provider: ModelProvider,
  text: string,
  categories: string[],
): Promise<UserContext> {
  const raw = await provider.complete(text, prompt(categories));
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  try {
    const value = JSON.parse(
      start >= 0 && end > start ? raw.slice(start, end + 1) : "{}",
    ) as Record<string, unknown>;
    return {
      preferred_categories:
        typeof value.category === "string" &&
        categories.includes(value.category)
          ? [value.category]
          : [],
      ...(typeof value.min_yuan === "number"
        ? { min_price_cents: Math.round(value.min_yuan * 100) }
        : {}),
      ...(typeof value.max_yuan === "number"
        ? { max_price_cents: Math.round(value.max_yuan * 100) }
        : {}),
    };
  } catch {
    return emptyContext();
  }
}
export function describe(c: UserContext): string {
  const bits = c.preferred_categories?.length
    ? [...c.preferred_categories]
    : ["不限类目"];
  if (c.min_price_cents)
    bits.push(`≥${Math.round(c.min_price_cents / 100)} 元`);
  if (c.max_price_cents)
    bits.push(`≤${Math.round(c.max_price_cents / 100)} 元`);
  return bits.join(" · ");
}
