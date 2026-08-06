/** 目录概览：前端开场用它渲染分类、用户选择器和当前模型。 */

import { DEMO_USERS } from "../../../data/demo-users.ts";
import { catalog, provider } from "../../../server/runtime.ts";

export function GET() {
  return Response.json({
    categories: catalog.categories,
    users: DEMO_USERS,
    product_count: catalog.products.length,
    model_id: provider.modelId,
  });
}
